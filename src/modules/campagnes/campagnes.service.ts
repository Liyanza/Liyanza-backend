import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateCampagneDto } from './dto/create-campagne.dto';
import { UpdateCampagneDto } from './dto/update-campagne.dto';
import { LancerCampagneDto } from './dto/lancer-campagne.dto';
import {
  BroadcastStatus,
  CampaignStatus,
  Prisma,
  Campaign,
} from '@prisma/client';
import { CampaignStateMachine } from './state/campaign-state-machine';

@Injectable()
export class CampagnesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Create a new campaign (status defaults to DRAFT)
   */
  async create(dto: CreateCampagneDto, user: AuthenticatedUser) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to create a campaign.',
      );
    }

    // Validate dates
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    this.validateDates(startDate, endDate);

    // Validate budget
    if (dto.plannedBudget <= 0) {
      throw new BadRequestException('Planned budget must be greater than 0.');
    }

    return this.prisma.campaign.create({
      data: {
        name: dto.name,
        startDate,
        endDate,
        plannedBudget: dto.plannedBudget,
        actualBudget: 0,
        status: CampaignStatus.DRAFT,
        objective: dto.objective,
        launchedById: user.userId,
      },
    });
  }

  /**
   * List all campaigns belonging to the user's company.
   */
  async findAll(
    user: AuthenticatedUser,
    page: number,
    limit: number,
    status?: CampaignStatus,
  ) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to list campaigns.',
      );
    }

    const skip = (page - 1) * limit;
    const where: Prisma.CampaignWhereInput = {
      launchedBy: {
        companyId: user.companyId,
      },
    };
    if (status) {
      where.status = status;
    }

    const [items, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          launchedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      }),
      this.prisma.campaign.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Find a single campaign by ID, ensuring it belongs to the user's company.
   */
  async findOne(id: string, user: AuthenticatedUser) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to view a campaign.',
      );
    }

    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id,
        launchedBy: {
          companyId: user.companyId,
        },
      },
      include: {
        launchedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }

    return campaign;
  }

  /**
   * Update a campaign. Only DRAFT campaigns can be updated (business rule).
   */
  async update(id: string, dto: UpdateCampagneDto, user: AuthenticatedUser) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to update a campaign.',
      );
    }

    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id,
        launchedBy: {
          companyId: user.companyId,
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }

    // Only DRAFT campaigns can be updated
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT campaigns can be updated.');
    }

    // CORRECTIF AUDIT (mineur — typage) : `Prisma.CampaignUpdateInput` est le
    // type d'entrée de `campaign.update()`, pas de `campaign.updateMany()` qui
    // attend `CampaignUpdateManyMutationInput`. Le premier autorise les champs
    // de relation (`launchedBy`, `channels`, `broadcasts`...) que `updateMany`
    // ne sait pas traiter : le compilateur validait donc un payload que Prisma
    // aurait rejeté à l'exécution.
    const updateData: Prisma.CampaignUpdateManyMutationInput = {};
    if (dto.name) updateData.name = dto.name;
    if (dto.objective) updateData.objective = dto.objective;
    if (dto.plannedBudget !== undefined) {
      if (dto.plannedBudget <= 0) {
        throw new BadRequestException('Planned budget must be greater than 0.');
      }
      updateData.plannedBudget = dto.plannedBudget;
    }
    if (dto.startDate) {
      const startDate = new Date(dto.startDate);
      const endDate = dto.endDate ? new Date(dto.endDate) : campaign.endDate;
      this.validateDates(startDate, endDate);
      updateData.startDate = startDate;
    }
    if (dto.endDate) {
      const startDate = dto.startDate
        ? new Date(dto.startDate)
        : campaign.startDate;
      const endDate = new Date(dto.endDate);
      this.validateDates(startDate, endDate);
      updateData.endDate = endDate;
    }

    // CORRECTIF AUDIT (mineur — race condition / TOCTOU) : la lecture
    // (`findFirst`) et l'écriture (`update`) étaient séparées sans verrou.
    // Deux requêtes concurrentes pouvaient toutes deux passer la validation
    // "status === DRAFT" avant qu'aucune n'ait écrit. On utilise désormais
    // un verrou optimiste : `updateMany` ne modifie la ligne QUE si son
    // statut est toujours DRAFT au moment de l'écriture ; sinon `count`
    // vaut 0 et on renvoie une erreur explicite plutôt qu'un résultat
    // silencieusement incohérent.
    // CORRECTIF AUDIT (complément) : le prédicat multi-tenant
    // (`launchedBy: { companyId }`), présent dans la lecture, était absent de
    // l'écriture. Le `findFirst` ci-dessus le rend non exploitable AUJOURD'HUI,
    // mais toute réorganisation ultérieure de cette méthode (early return,
    // extraction d'un helper, mise en cache de la lecture) transformerait
    // l'omission en IDOR inter-tenant silencieux. On réaffirme le scope dans
    // la clause d'écriture : défense en profondeur, coût nul.
    const result = await this.prisma.campaign.updateMany({
      where: {
        id,
        status: CampaignStatus.DRAFT,
        launchedBy: { companyId: user.companyId },
      },
      data: updateData,
    });
    if (result.count === 0) {
      throw new ConflictException(
        'The campaign status has changed in the meantime, please try again.',
      );
    }

    return this.prisma.campaign.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Transition a campaign to a new status using the state machine.
   */
  async lancer(id: string, dto: LancerCampagneDto, user: AuthenticatedUser) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to change campaign status.',
      );
    }

    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id,
        launchedBy: {
          companyId: user.companyId,
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }

    // Validate the transition
    CampaignStateMachine.validateTransition(campaign.status, dto.status);

    // If transitioning from DRAFT to PLANNED, ensure the campaign is complete
    if (
      campaign.status === CampaignStatus.DRAFT &&
      dto.status === CampaignStatus.PLANNED
    ) {
      await this.validateCampaignComplete(campaign);
    }

    // Perform the update
    // CORRECTIF AUDIT (mineur — race condition / TOCTOU) : même principe
    // que dans `update()` — on ne transitionne que si le statut lu est
    // toujours celui observé au moment de la validation.
    //
    // CORRECTIF AUDIT (majeur — transition sans effet de bord) : annuler une
    // campagne n'écrivait QUE `Campaign.status`. Les `Broadcast` rattachés
    // restaient au statut `PLANNED` : le rapport de conformité continuait de
    // les comptabiliser puis de les basculer en « MISSED » une fois leur date
    // passée, dégradant le taux de conformité d'une campagne pourtant
    // annulée. L'enum `BroadcastStatus.CANCELLED` existait dans le schéma
    // mais n'était écrite nulle part dans tout `src/`.
    //
    // Le changement de statut et sa propagation doivent être atomiques : sans
    // transaction, un échec après le premier `UPDATE` laisserait une campagne
    // annulée avec des diffusions toujours actives.
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.campaign.updateMany({
        where: {
          id,
          status: campaign.status,
          launchedBy: { companyId: user.companyId },
        },
        data: { status: dto.status },
      });
      if (result.count === 0) {
        throw new ConflictException(
          'The campaign status has changed in the meantime, please try again.',
        );
      }

      if (dto.status === CampaignStatus.CANCELLED) {
        // Seules les diffusions encore à venir sont annulées : celles déjà
        // constatées (BROADCASTED) sont des faits, on ne réécrit pas
        // l'historique.
        await tx.broadcast.updateMany({
          where: { campaignId: id, status: BroadcastStatus.PLANNED },
          data: { status: BroadcastStatus.CANCELLED },
        });
      }
    });

    return this.prisma.campaign.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Valide la cohérence de la fenêtre temporelle d'une campagne.
   *
   * CORRECTIF AUDIT (mineur) : seul `startDate > endDate` était rejeté. Une
   * campagne de durée nulle (`startDate === endDate`) était donc acceptée,
   * de même qu'une campagne dont la fenêtre était entièrement dans le passé —
   * y compris à la création. Ces deux cas rendent impossible toute
   * planification de diffusion cohérente en aval.
   */
  private validateDates(startDate: Date, endDate: Date): void {
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid campaign dates.');
    }
    if (startDate >= endDate) {
      throw new BadRequestException('End date must be after start date.');
    }
  }

  /**
   * Vérifie qu'une campagne est réellement prête à passer de DRAFT à PLANNED.
   *
   * CORRECTIF AUDIT (majeur — garde inopérante) : la version précédente
   * testait la présence de `name`, `objective`, `startDate`, `endDate` et un
   * budget strictement positif. AUCUNE de ces cinq conditions ne pouvait être
   * fausse : les quatre premiers champs sont NOT NULL en base
   * (prisma/schema.prisma) et `@IsNotEmpty()` dans `CreateCampagneDto` ;
   * `update()` ne permet jamais de les vider (`if (dto.name)` ignore la chaîne
   * vide) ; et `plannedBudget` est borné par `@Min(0.01)`. La méthode était
   * donc du code mort intégral : la porte DRAFT -> PLANNED ne validait rien.
   *
   * On la remplace par les invariants métier qui, eux, peuvent réellement être
   * violés : une campagne ne peut être planifiée sans canal de diffusion ni
   * planning, et sa fenêtre doit encore avoir un sens au moment du passage.
   */
  private async validateCampaignComplete(campaign: Campaign): Promise<void> {
    if (campaign.endDate <= new Date()) {
      throw new BadRequestException(
        'Cannot plan a campaign whose end date has already passed.',
      );
    }

    const [channelCount, broadcastCount] = await Promise.all([
      this.prisma.advertisingChannel.count({
        where: { campaignId: campaign.id },
      }),
      this.prisma.broadcast.count({ where: { campaignId: campaign.id } }),
    ]);

    if (channelCount === 0) {
      throw new BadRequestException(
        'Cannot plan a campaign without any advertising channel. Associate at least one channel first.',
      );
    }
    if (broadcastCount === 0) {
      throw new BadRequestException(
        'Cannot plan a campaign without any scheduled broadcast. Create the broadcast schedule first.',
      );
    }
  }
}
