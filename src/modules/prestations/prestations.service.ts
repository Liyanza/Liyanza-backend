import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { CreatePrestationDto } from './dto/create-prestation.dto';
import { SoumettrePreuveDto } from './dto/soumettre-preuve.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { ValidationLinkResponseDto } from './dto/validation-link-response.dto';
import { ValidationConsultationResponseDto } from './dto/validation-consultation-response.dto';
import { ProofLinkResponseDto } from './dto/proof-link-response.dto';
import { ProofLinkConsultationResponseDto } from './dto/proof-link-consultation-response.dto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { parseDuration } from '../../common/utils/duration.util';
import {
  haversineDistanceMeters,
  isLocationMatch,
} from '../../common/utils/geo.util';
import { CampaignStatus, Role } from '@prisma/client';

/** Préfixe Redis utilisé pour le suivi d'usage unique des liens de validation. */
const VALIDATION_LINK_REDIS_PREFIX = 'validation-link:';
/** Idem pour les liens de soumission de preuve (prestataire sans compte). */
const PROOF_LINK_REDIS_PREFIX = 'proof-link:';

type LinkTokenType = 'validation' | 'proof';

interface ValidationTokenPayload {
  sub: string; // installationId
  type: LinkTokenType;
  jti: string;
}

@Injectable()
export class PrestationsService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private redisService: RedisService,
  ) {}

  private validateCoordinates(lat: number, lng: number): void {
    if (lat < -90 || lat > 90) {
      throw new BadRequestException('Latitude must be between -90 and 90.');
    }
    if (lng < -180 || lng > 180) {
      throw new BadRequestException('Longitude must be between -180 and 180.');
    }
  }

  async createPrestation(
    campaignId: string,
    dto: CreatePrestationDto,
    user: AuthenticatedUser,
  ) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to create an installation.',
      );
    }

    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id: campaignId,
        launchedBy: { companyId: user.companyId },
      },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }
    if (
      campaign.status === CampaignStatus.COMPLETED ||
      campaign.status === CampaignStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'Cannot add installations to a completed or cancelled campaign.',
      );
    }

    this.validateCoordinates(dto.plannedLatitude, dto.plannedLongitude);

    const plannedDate = new Date(dto.plannedInstallationDate);
    if (isNaN(plannedDate.getTime())) {
      throw new BadRequestException('Invalid planned installation date.');
    }

    // CORRECTIF (écart fonctionnel majeur) : le prestataire assigné doit
    // réellement exister, appartenir à la même entreprise (pas de scope
    // cross-tenant) et porter le rôle PROVIDER — sinon
    // `POST /prestations/:id/preuve` resterait inatteignable pour lui (voir
    // le commentaire sur `CreatePrestationDto.providerId`).
    const provider = await this.prisma.user.findFirst({
      where: { id: dto.providerId, companyId: user.companyId },
    });
    if (!provider) {
      throw new NotFoundException('Prestataire introuvable.');
    }
    if (provider.role !== Role.PROVIDER) {
      throw new BadRequestException(
        "L'utilisateur assigné doit avoir le rôle PROVIDER.",
      );
    }

    return this.prisma.installation.create({
      data: {
        location: dto.location,
        plannedLatitude: dto.plannedLatitude,
        plannedLongitude: dto.plannedLongitude,
        plannedInstallationDate: plannedDate,
        status: 'PLANNED',
        campaignId: campaign.id,
        providerId: provider.id,
      },
    });
  }

  async soumettrePreuve(
    installationId: string,
    dto: SoumettrePreuveDto,
    user: AuthenticatedUser,
  ) {
    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
      include: {
        campaign: { include: { launchedBy: true } },
        provider: true,
      },
    });
    if (!installation) {
      throw new NotFoundException('Installation not found.');
    }

    assertSameCompany(
      user,
      installation.campaign.launchedBy.companyId,
      'Installation',
    );

    if (user.role !== Role.ADMIN && installation.providerId !== user.userId) {
      throw new ForbiddenException(
        'You are not authorized to submit proof for this installation.',
      );
    }

    return this.createProofRecord(
      installation,
      dto,
      `Proof submitted by ${user.email}`,
    );
  }

  /**
   * Cœur de la soumission de preuve, partagé entre le flux authentifié
   * (`soumettrePreuve`, rôle PROVIDER) et le flux externe sans compte
   * (`soumettrePreuveViaLien`) — seule l'autorisation en amont diffère, la
   * validation et l'écriture sont strictement identiques.
   */
  private async createProofRecord(
    installation: { id: string; status: string },
    dto: SoumettrePreuveDto,
    historyComment: string,
  ) {
    this.validateCoordinates(dto.latitude, dto.longitude);

    const takenAt = new Date(dto.takenAt);
    if (isNaN(takenAt.getTime())) {
      throw new BadRequestException('Invalid takenAt date.');
    }

    const existingProof = await this.prisma.publicationProof.findUnique({
      where: { installationId: installation.id },
    });
    if (existingProof) {
      throw new ConflictException(
        'A proof has already been submitted for this installation.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const proof = await tx.publicationProof.create({
        data: {
          photo: dto.photo,
          latitude: dto.latitude,
          longitude: dto.longitude,
          takenAt,
          validationStatus: 'PENDING',
          installationId: installation.id,
        },
      });

      const previousStatus = installation.status;
      const newStatus = 'INSTALLED';
      if (previousStatus !== newStatus) {
        await tx.installation.update({
          where: { id: installation.id },
          data: { status: newStatus },
        });
        await tx.statusHistory.create({
          data: {
            previousStatus,
            newStatus,
            changedAt: new Date(),
            comment: historyComment,
            installationId: installation.id,
          },
        });
      }

      return proof;
    });
  }

  async updateStatus(
    installationId: string,
    dto: UpdateStatusDto,
    user: AuthenticatedUser,
  ) {
    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
      include: {
        campaign: { include: { launchedBy: true } },
      },
    });
    if (!installation) {
      throw new NotFoundException('Installation not found.');
    }

    assertSameCompany(
      user,
      installation.campaign.launchedBy.companyId,
      'Installation',
    );

    if (user.role !== Role.ADMIN && user.role !== Role.MARKETING_MANAGER) {
      throw new ForbiddenException('Insufficient role to update status.');
    }

    // `Installation.status` est une colonne `String` libre côté Prisma, tandis
    // que le DTO est désormais contraint par l'enum `InstallationStatus`
    // (correctif d'audit). La comparaison se fait donc explicitement sur des
    // chaînes tant que la migration du schéma n'a pas été appliquée.
    if (installation.status === (dto.status as string)) {
      return installation;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.installation.update({
        where: { id: installationId },
        data: { status: dto.status },
      });

      await tx.statusHistory.create({
        data: {
          previousStatus: installation.status,
          newStatus: dto.status,
          changedAt: new Date(),
          comment: dto.comment || null,
          installationId: installation.id,
        },
      });

      return updated;
    });

    return result;
  }

  async getHistorique(installationId: string, user: AuthenticatedUser) {
    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
      include: {
        campaign: { include: { launchedBy: true } },
        statusHistory: {
          orderBy: { changedAt: 'desc' },
        },
      },
    });
    if (!installation) {
      throw new NotFoundException('Installation not found.');
    }

    assertSameCompany(
      user,
      installation.campaign.launchedBy.companyId,
      'Installation',
    );

    return installation.statusHistory;
  }

  async generateValidationLink(
    installationId: string,
    user: AuthenticatedUser,
  ) {
    // Fetch installation with proof and campaign
    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
      include: {
        campaign: { include: { launchedBy: true } },
        proof: true,
      },
    });
    if (!installation) {
      throw new NotFoundException('Installation not found.');
    }
    assertSameCompany(
      user,
      installation.campaign.launchedBy.companyId,
      'Installation',
    );

    // Ensure a proof exists
    if (!installation.proof) {
      throw new BadRequestException(
        'No proof associated with this installation. Cannot generate a validation link.',
      );
    }

    const { token, expiresAt } = await this.signSingleUseLink(
      installationId,
      'validation',
      VALIDATION_LINK_REDIS_PREFIX,
    );
    const baseUrl = this.configService.get<string>('VALIDATION_BASE_URL');
    if (!baseUrl) {
      throw new InternalServerErrorException(
        'Validation base URL not configured.',
      );
    }

    return new ValidationLinkResponseDto({
      link: `${baseUrl}/${token}`,
      token,
      expiresAt: expiresAt.toISOString(),
    });
  }

  /**
   * `POST /prestations/:id/lien-preuve` — génère le lien à usage unique
   * envoyé au prestataire externe (sans compte Liyanza) pour qu'il soumette
   * lui-même sa preuve. Contrairement à `generateValidationLink`, ne
   * suppose PAS qu'une preuve existe déjà — c'est justement ce lien qui va
   * permettre d'en créer une.
   */
  async generateProofLink(installationId: string, user: AuthenticatedUser) {
    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
      include: { campaign: { include: { launchedBy: true } } },
    });
    if (!installation) {
      throw new NotFoundException('Installation not found.');
    }
    assertSameCompany(
      user,
      installation.campaign.launchedBy.companyId,
      'Installation',
    );

    const { token, expiresAt } = await this.signSingleUseLink(
      installationId,
      'proof',
      PROOF_LINK_REDIS_PREFIX,
    );
    const baseUrl = this.configService.get<string>('PROOF_SUBMISSION_BASE_URL');
    if (!baseUrl) {
      throw new InternalServerErrorException(
        'Proof submission base URL not configured.',
      );
    }

    return new ProofLinkResponseDto({
      link: `${baseUrl}/${token}`,
      token,
      expiresAt: expiresAt.toISOString(),
    });
  }

  /**
   * Signe un token à usage unique (JWT + `jti` suivi dans Redis) pour un
   * lien externe sans compte — factorisé entre les liens de validation
   * (BACK-308) et de preuve : même mécanisme de sécurité, seul le `type`
   * embarqué et le préfixe Redis diffèrent.
   *
   * CORRECTIF AUDIT (majeur, hérité) : le lien était documenté comme
   * "single-use" sans que rien ne l'impose réellement (pas de `jti`, pas de
   * trace d'usage). Un identifiant unique est enregistré dans Redis avec le
   * même TTL que le token, à l'état "unused" — la consommation ne l'accepte
   * qu'une seule fois (`GETDEL` atomique, voir plus bas).
   */
  private async signSingleUseLink(
    installationId: string,
    type: LinkTokenType,
    redisPrefix: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const jti = randomUUID();
    const payload: ValidationTokenPayload = {
      sub: installationId,
      type,
      jti,
    };
    const expiresIn =
      this.configService.get<string>('jwt.validationExpiration') ?? '7d';
    const token = this.jwtService.sign(payload);

    const seconds = parseDuration(expiresIn);
    const expiresAt = new Date(Date.now() + seconds * 1000);

    await this.redisService.set(`${redisPrefix}${jti}`, 'unused', seconds);

    return { token, expiresAt };
  }

  /**
   * Décode et valide la structure d'un token de lien externe (signature,
   * expiration, claims attendus, et le `type` attendu pour cet endpoint —
   * un lien de validation ne doit jamais être accepté là où un lien de
   * preuve est attendu, et inversement). Ne dit rien de l'état
   * "unused"/consommé du `jti`, qui reste vérifié séparément (Redis) car
   * seule la consommation doit y toucher.
   */
  private verifyLinkToken(
    token: string,
    expectedType: LinkTokenType,
  ): ValidationTokenPayload {
    let payload: ValidationTokenPayload;
    try {
      payload = this.jwtService.verify<ValidationTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Lien invalide ou expiré.');
    }

    if (payload.type !== expectedType || !payload.jti || !payload.sub) {
      throw new UnauthorizedException('Lien invalide.');
    }

    return payload;
  }

  /**
   * `GET /prestations/lien-validation/:token` (BACK-308, endpoint public) :
   * consultation en **lecture seule**, ne consomme jamais le `jti` — le
   * publicitaire externe doit pouvoir revoir la preuve avant de la valider,
   * et recharger la page après validation sans que ça casse quoi que ce
   * soit. Volontairement disponible même après consommation (le token reste
   * la preuve de possession du lien, indépendamment de son état Redis) :
   * `validationStatus` reflète alors l'état réel ("VALIDATED").
   */
  async consulterLienValidation(
    token: string,
  ): Promise<ValidationConsultationResponseDto> {
    const payload = this.verifyLinkToken(token, 'validation');

    const installation = await this.prisma.installation.findUnique({
      where: { id: payload.sub },
      include: { proof: true },
    });
    if (!installation || !installation.proof) {
      throw new NotFoundException(
        'Installation ou preuve de publication introuvable.',
      );
    }

    const distanceMeters = haversineDistanceMeters(
      installation.plannedLatitude,
      installation.plannedLongitude,
      installation.proof.latitude,
      installation.proof.longitude,
    );

    return new ValidationConsultationResponseDto({
      location: installation.location,
      photo: installation.proof.photo,
      latitude: installation.proof.latitude,
      longitude: installation.proof.longitude,
      takenAt: installation.proof.takenAt.toISOString(),
      validationStatus: installation.proof.validationStatus,
      validationComment: installation.proof.validationComment,
      distanceMeters,
      locationMatch: isLocationMatch(distanceMeters),
    });
  }

  /**
   * `POST /prestations/lien-validation/:token` (endpoint public, sans JWT
   * d'authentification applicatif — le token de validation lui-même en
   * tient lieu). Consomme le lien (usage unique) et valide la preuve.
   *
   * CORRECTIF AUDIT (majeur) : applique réellement la sémantique
   * "single-use" annoncée par `ValidationLinkResponseDto` : le token n'est
   * accepté que si son `jti` est toujours marqué "unused" dans Redis. La
   * lecture et l'invalidation sont effectuées en une seule opération
   * atomique (`GETDEL`) — voir `RedisService.getDel` — de sorte qu'un rejeu
   * concurrent du même lien soit systématiquement rejeté, sans fenêtre de
   * course entre lecture et suppression.
   */
  async consumeValidationLink(token: string, commentaire?: string) {
    const payload = this.verifyLinkToken(token, 'validation');

    // CORRECTIF (complément) : `get` suivi de `del` n'est PAS atomique — deux
    // requêtes concurrentes présentant le même lien pourraient toutes deux
    // lire "unused" avant qu'aucune n'ait supprimé la clé. `getDel` combine
    // les deux opérations en une seule commande Redis atomique : au plus un
    // appelant reçoit 'unused', tous les autres reçoivent `null`.
    const redisKey = `${VALIDATION_LINK_REDIS_PREFIX}${payload.jti}`;
    const status = await this.redisService.getDel(redisKey);
    if (status !== 'unused') {
      throw new UnauthorizedException(
        'Ce lien de validation a déjà été utilisé ou est expiré.',
      );
    }

    const installation = await this.prisma.installation.findUnique({
      where: { id: payload.sub },
      include: { proof: true },
    });
    if (!installation || !installation.proof) {
      throw new NotFoundException(
        'Installation ou preuve de publication introuvable.',
      );
    }

    return this.prisma.publicationProof.update({
      where: { installationId: installation.id },
      data: {
        validationStatus: 'VALIDATED',
        validationComment: commentaire ?? null,
      },
    });
  }

  /**
   * `GET /prestations/lien-preuve/:token` (endpoint public, sans compte) —
   * lecture seule, ne consomme jamais le `jti` : le prestataire doit pouvoir
   * ouvrir le lien, lire ce qu'on attend de lui, avant de déclencher sa
   * caméra.
   */
  async consulterLienPreuve(
    token: string,
  ): Promise<ProofLinkConsultationResponseDto> {
    const payload = this.verifyLinkToken(token, 'proof');

    const installation = await this.prisma.installation.findUnique({
      where: { id: payload.sub },
      include: { campaign: true, proof: true },
    });
    if (!installation) {
      throw new NotFoundException('Installation introuvable.');
    }

    return new ProofLinkConsultationResponseDto({
      location: installation.location,
      campaignName: installation.campaign.name,
      plannedInstallationDate:
        installation.plannedInstallationDate.toISOString(),
      alreadySubmitted: Boolean(installation.proof),
    });
  }

  /**
   * `POST /prestations/lien-preuve/:token` (endpoint public, sans compte) —
   * consomme le lien (usage unique, même mécanisme `GETDEL` que
   * `consumeValidationLink`) et crée la preuve. Renvoie l'écart de
   * localisation calculé immédiatement : le prestataire (ou la personne qui
   * l'accompagne) voit tout de suite si la pose semble au bon endroit,
   * plutôt que de l'apprendre après coup depuis le dashboard entreprise.
   */
  async soumettrePreuveViaLien(token: string, dto: SoumettrePreuveDto) {
    const payload = this.verifyLinkToken(token, 'proof');

    const redisKey = `${PROOF_LINK_REDIS_PREFIX}${payload.jti}`;
    const status = await this.redisService.getDel(redisKey);
    if (status !== 'unused') {
      throw new UnauthorizedException(
        'Ce lien de preuve a déjà été utilisé ou est expiré.',
      );
    }

    const installation = await this.prisma.installation.findUnique({
      where: { id: payload.sub },
    });
    if (!installation) {
      throw new NotFoundException('Installation introuvable.');
    }

    const proof = await this.createProofRecord(
      installation,
      dto,
      'Proof submitted via external link (no account)',
    );

    const distanceMeters = haversineDistanceMeters(
      installation.plannedLatitude,
      installation.plannedLongitude,
      proof.latitude,
      proof.longitude,
    );

    return {
      proofId: proof.id,
      distanceMeters,
      locationMatch: isLocationMatch(distanceMeters),
    };
  }

  /**
   * `GET /prestations` — toutes les installations de l'entreprise, avec leur
   * preuve si elle existe, pour la carte de suivi terrain. L'écart de
   * localisation est calculé à la volée (jamais persisté : il ne dépend que
   * de deux paires de coordonnées déjà en base, aucune migration requise).
   */
  async listInstallations(user: AuthenticatedUser) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to view installations.',
      );
    }

    const installations = await this.prisma.installation.findMany({
      where: { campaign: { launchedBy: { companyId: user.companyId } } },
      include: { campaign: true, proof: true },
      orderBy: { plannedInstallationDate: 'desc' },
    });

    return installations.map((installation) => {
      const distanceMeters = installation.proof
        ? haversineDistanceMeters(
            installation.plannedLatitude,
            installation.plannedLongitude,
            installation.proof.latitude,
            installation.proof.longitude,
          )
        : null;

      return {
        id: installation.id,
        location: installation.location,
        campaignId: installation.campaignId,
        campaignName: installation.campaign.name,
        status: installation.status,
        plannedLatitude: installation.plannedLatitude,
        plannedLongitude: installation.plannedLongitude,
        plannedInstallationDate:
          installation.plannedInstallationDate.toISOString(),
        proof: installation.proof
          ? {
              photo: installation.proof.photo,
              latitude: installation.proof.latitude,
              longitude: installation.proof.longitude,
              takenAt: installation.proof.takenAt.toISOString(),
              validationStatus: installation.proof.validationStatus,
            }
          : null,
        distanceMeters,
        locationMatch:
          distanceMeters !== null ? isLocationMatch(distanceMeters) : null,
      };
    });
  }
}
