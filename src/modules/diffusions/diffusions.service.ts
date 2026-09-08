import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { UpdateDiffusionReelleDto } from './dto/update-diffusion-reelle.dto';
import {
  RapportConformiteDto,
  RapportConformiteItemDto,
} from './dto/rapport-conformite.dto';
import { BroadcastStatus, Prisma } from '@prisma/client';

@Injectable()
export class DiffusionsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Updates a broadcast with the actual time and audio proof.
   * Idempotency: if already constat exists, throws ConflictException.
   */
  async updateConstat(
    id: string,
    dto: UpdateDiffusionReelleDto,
    user: AuthenticatedUser,
  ) {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id },
      include: {
        campaign: {
          include: { launchedBy: true },
        },
      },
    });
    if (!broadcast) {
      throw new NotFoundException('Broadcast not found.');
    }

    // Ensure user belongs to the same company
    assertSameCompany(
      user,
      broadcast.campaign.launchedBy.companyId,
      'Broadcast',
    );

    // Idempotence: prevent double update
    if (broadcast.actualBroadcastAt) {
      throw new ConflictException(
        'A constat has already been recorded for this broadcast.',
      );
    }

    // CORRECTIF AUDIT (mineur — typage) : `const updateData: any` désactivait
    // toute vérification sur le payload d'écriture Prisma. Une faute de frappe
    // sur un nom de champ (ou un champ retiré du schéma) n'aurait été
    // détectée qu'à l'exécution, en production.
    const updateData: Prisma.BroadcastUpdateManyMutationInput = {
      status: BroadcastStatus.BROADCASTED,
    };
    if (dto.actualBroadcastAt) {
      updateData.actualBroadcastAt = new Date(dto.actualBroadcastAt);
    }
    if (dto.audioProof !== undefined) {
      updateData.audioProof = dto.audioProof;
    }

    // CORRECTIF AUDIT (majeur — race condition / TOCTOU) : le contrôle
    // d'idempotence ci-dessus (lecture) et l'écriture étaient séparés sans
    // verrou. Deux requêtes concurrentes constataient toutes deux
    // `actualBroadcastAt === null`, passaient la garde, et écrasaient
    // successivement le constat — la seconde écrasant silencieusement la
    // preuve audio de la première, sans qu'aucune erreur ne soit levée.
    //
    // Verrou optimiste : l'écriture n'a lieu que si `actualBroadcastAt` est
    // TOUJOURS nul au moment du `UPDATE`. Au plus une requête concurrente
    // obtient `count === 1`.
    const result = await this.prisma.broadcast.updateMany({
      where: { id, actualBroadcastAt: null },
      data: updateData,
    });
    if (result.count === 0) {
      throw new ConflictException(
        'A constat has already been recorded for this broadcast.',
      );
    }

    return this.prisma.broadcast.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Generates a compliance report for a campaign.
   * Calculates for each broadcast: actual status and deviation in minutes.
   */
  async getRapportConformite(
    campaignId: string,
    user: AuthenticatedUser,
  ): Promise<RapportConformiteDto> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { launchedBy: true },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }
    assertSameCompany(user, campaign.launchedBy.companyId, 'Campaign');

    const broadcasts = await this.prisma.broadcast.findMany({
      where: { campaignId },
      orderBy: { scheduledAt: 'asc' },
    });

    const now = new Date();
    const items: RapportConformiteItemDto[] = [];
    let broadcasted = 0;
    let missed = 0;
    let pending = 0;
    let cancelled = 0;

    for (const b of broadcasts) {
      let status: string;
      let ecartMinutes: number | null = null;

      // CORRECTIF AUDIT (majeur — indicateur faux) : la colonne
      // `Broadcast.status` était totalement ignorée dans ce calcul, qui ne
      // regardait que `actualBroadcastAt`. Conséquence : une diffusion
      // ANNULÉE (`BroadcastStatus.CANCELLED`) dont la date planifiée était
      // passée était comptabilisée comme MANQUÉE, dégradant artificiellement
      // le taux de conformité présenté à l'annonceur — et donc, potentiellement,
      // une facturation ou une pénalité contractuelle erronée.
      if (b.status === BroadcastStatus.CANCELLED) {
        status = 'CANCELLED';
        cancelled++;
      } else if (b.actualBroadcastAt) {
        status = 'BROADCASTED';
        broadcasted++;
        const diffMs = b.actualBroadcastAt.getTime() - b.scheduledAt.getTime();
        ecartMinutes = Math.round(diffMs / 60000);
      } else {
        if (b.scheduledAt < now) {
          status = 'MISSED';
          missed++;
        } else {
          status = 'PENDING';
          pending++;
        }
      }

      items.push({
        diffusionId: b.id,
        scheduledAt: b.scheduledAt,
        actualBroadcastAt: b.actualBroadcastAt || null,
        status,
        ecartMinutes,
      });
    }

    return {
      campagneId: campaign.id,
      campagneNom: campaign.name,
      diffusions: items,
      totalDiffusions: broadcasts.length,
      diffusionsDiffusees: broadcasted,
      diffusionsManquees: missed,
      diffusionsEnAttente: pending,
      diffusionsAnnulees: cancelled,
      // Le taux de conformité exclut les diffusions annulées du dénominateur :
      // une diffusion annulée d'un commun accord n'est pas un manquement.
      tauxConformite:
        broadcasted + missed > 0
          ? Number((broadcasted / (broadcasted + missed)).toFixed(4))
          : null,
    };
  }
}
