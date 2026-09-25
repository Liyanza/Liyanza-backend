import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { UpsertDigitalDetailsDto } from './dto/upsert-digital-details.dto';
import { SelectDigitalChannelsDto } from './dto/select-digital-channels.dto';
import type { DigitalSimulationEngineInterface } from './clients/digital-simulation-engine.interface';
import { DIGITAL_SIMULATION_ENGINE_TOKEN } from './clients/digital-simulation-engine.interface';
import type {
  DigitalSimulationParameters,
  DigitalSimulationResult,
} from './clients/digital-simulation-engine.interface';
import {
  SimulationAnalysisClient,
  type SimulationAnalysis,
} from './clients/simulation-analysis.client';
import {
  Campaign,
  CampaignStatus,
  CampaignType,
  Prisma,
  SocialAccountStatus,
  SocialPlatform,
} from '@prisma/client';

@Injectable()
export class DigitalCampaignsService {
  private readonly logger = new Logger(DigitalCampaignsService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(DIGITAL_SIMULATION_ENGINE_TOKEN)
    private simulationEngine: DigitalSimulationEngineInterface,
    private simulationAnalysis: SimulationAnalysisClient,
  ) {}

  async upsertDetails(
    campaignId: string,
    dto: UpsertDigitalDetailsDto,
    user: AuthenticatedUser,
  ) {
    const campaign = await this.validateDigitalCampaignAccess(campaignId, user);
    this.validateEditable(campaign);

    if (dto.ageMin > dto.ageMax) {
      throw new BadRequestException(
        'ageMin must be less than or equal to ageMax.',
      );
    }

    const details = await this.prisma.digitalCampaignDetails.upsert({
      where: { campaignId: campaign.id },
      create: {
        campaignId: campaign.id,
        objective: dto.objective,
        ageMin: dto.ageMin,
        ageMax: dto.ageMax,
        targetGender: dto.targetGender,
        targetLocations: dto.targetLocations,
        targetInterests: dto.targetInterests,
        budgetAllocation: dto.budgetAllocation,
      },
      update: {
        objective: dto.objective,
        ageMin: dto.ageMin,
        ageMax: dto.ageMax,
        targetGender: dto.targetGender,
        targetLocations: dto.targetLocations,
        targetInterests: dto.targetInterests,
        budgetAllocation: dto.budgetAllocation,
      },
    });

    return details;
  }

  async getDetails(campaignId: string, user: AuthenticatedUser) {
    const campaign = await this.validateDigitalCampaignAccess(campaignId, user);

    const details = await this.prisma.digitalCampaignDetails.findUnique({
      where: { campaignId: campaign.id },
      include: {
        channels: {
          include: {
            socialAccount: {
              select: {
                id: true,
                platform: true,
                externalAccountName: true,
                status: true,
                lastSyncedAt: true,
              },
            },
          },
        },
      },
    });
    if (!details) {
      throw new NotFoundException('Digital campaign details not found.');
    }
    return details;
  }

  async selectChannels(
    campaignId: string,
    dto: SelectDigitalChannelsDto,
    user: AuthenticatedUser,
  ) {
    const campaign = await this.validateDigitalCampaignAccess(campaignId, user);
    this.validateEditable(campaign);

    const details = await this.prisma.digitalCampaignDetails.findUnique({
      where: { campaignId: campaign.id },
    });
    if (!details) {
      throw new BadRequestException(
        'Complete the campaign objective, audience and budget before selecting channels.',
      );
    }

    const platforms = dto.channels.map((c) => c.platform);
    if (new Set(platforms).size !== platforms.length) {
      throw new BadRequestException('Each platform can only be selected once.');
    }

    // Les comptes sociaux référencés doivent appartenir à la même entreprise
    // ET correspondre à la plateforme du canal — jamais de confiance dans
    // l'association fournie par le client.
    const socialAccountIds = dto.channels
      .map((c) => c.socialAccountId)
      .filter((id): id is string => Boolean(id));
    const socialAccounts =
      socialAccountIds.length > 0
        ? await this.prisma.socialAccount.findMany({
            where: { id: { in: socialAccountIds }, companyId: user.companyId! },
          })
        : [];
    const socialAccountsById = new Map(socialAccounts.map((a) => [a.id, a]));

    for (const channel of dto.channels) {
      if (!channel.socialAccountId) continue;
      const account = socialAccountsById.get(channel.socialAccountId);
      if (!account) {
        throw new NotFoundException(
          `Social account ${channel.socialAccountId} not found.`,
        );
      }
      if (account.platform !== channel.platform) {
        throw new BadRequestException(
          `Social account ${channel.socialAccountId} does not match platform ${channel.platform}.`,
        );
      }
    }

    // Canal sans compte précisé (cas du site et de l'app) : on lui rattache
    // le compte ACTIF de l'entreprise pour cette plateforme, sans quoi la
    // simulation ignorerait les métriques réelles de la Page déjà liée.
    const activeAccounts = dto.channels.some((c) => !c.socialAccountId)
      ? await this.activeAccountsByPlatform(user.companyId!)
      : new Map<SocialPlatform, { id: string }>();

    const channels = await this.prisma.$transaction(
      dto.channels
        .map((channel) => ({
          ...channel,
          socialAccountId:
            channel.socialAccountId ?? activeAccounts.get(channel.platform)?.id,
        }))
        .map((channel) =>
          this.prisma.digitalCampaignChannel.upsert({
            where: {
              digitalCampaignDetailsId_platform: {
                digitalCampaignDetailsId: details.id,
                platform: channel.platform,
              },
            },
            create: {
              digitalCampaignDetailsId: details.id,
              platform: channel.platform,
              socialAccountId: channel.socialAccountId,
            },
            update: {
              socialAccountId: channel.socialAccountId ?? null,
            },
          }),
        ),
    );

    return channels;
  }

  async createSimulation(campaignId: string, user: AuthenticatedUser) {
    const campaign = await this.validateDigitalCampaignAccess(campaignId, user);

    const details = await this.prisma.digitalCampaignDetails.findUnique({
      where: { campaignId: campaign.id },
      include: { channels: { include: { socialAccount: true } } },
    });
    if (!details) {
      throw new BadRequestException(
        'Complete the campaign objective, audience and budget before simulating.',
      );
    }
    if (details.channels.length === 0) {
      throw new BadRequestException(
        'Select at least one diffusion channel before simulating.',
      );
    }

    // Campagnes dont les canaux n'ont pas de compte rattaché (ou un compte
    // expiré/déconnecté depuis) : repli sur le compte actif de l'entreprise.
    const needsFallback = details.channels.some(
      (c) => c.socialAccount?.status !== SocialAccountStatus.ACTIVE,
    );
    const activeAccounts = needsFallback
      ? await this.activeAccountsByPlatform(user.companyId!)
      : new Map<SocialPlatform, { id: string }>();

    const channelInputs = await Promise.all(
      details.channels.map(async (channel) => {
        const account =
          channel.socialAccount?.status === SocialAccountStatus.ACTIVE
            ? channel.socialAccount
            : activeAccounts.get(channel.platform);
        if (!account) {
          return { platform: channel.platform, metrics: null };
        }
        const latestMetric = await this.prisma.platformMetric.findFirst({
          where: { socialAccountId: account.id },
          orderBy: { fetchedAt: 'desc' },
        });
        if (!latestMetric) {
          return {
            platform: channel.platform,
            metrics: null,
            accountLinked: true,
          };
        }
        return {
          platform: channel.platform,
          accountLinked: true,
          metrics: {
            followerCount: latestMetric.followerCount ?? undefined,
            reach: latestMetric.reach ?? undefined,
            impressions: latestMetric.impressions ?? undefined,
            engagementRate: latestMetric.engagementRate ?? undefined,
            avgCpm: latestMetric.avgCpm?.toNumber(),
            avgCpc: latestMetric.avgCpc?.toNumber(),
          },
        };
      }),
    );

    const parameters = {
      objective: details.objective,
      budget: {
        amount: campaign.plannedBudget.toNumber(),
        allocation: details.budgetAllocation,
      },
      audience: {
        ageMin: details.ageMin,
        ageMax: details.ageMax,
        targetGender: details.targetGender,
        locations: details.targetLocations,
        interests: details.targetInterests,
      },
      channels: channelInputs as Parameters<
        DigitalSimulationEngineInterface['simulate']
      >[0]['channels'],
    };

    // Le moteur est appelé AVANT toute écriture (même correctif d'atomicité
    // que `SimulationsService.createSimulation`, voir CORRECTIF AUDIT
    // associé) : une panne du moteur ne doit jamais laisser d'écriture
    // orpheline.
    let result;
    try {
      result = await this.simulationEngine.simulate(parameters);
    } catch (error) {
      this.logger.error(
        `Digital simulation engine failure for campaign ${campaign.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException(
        'Failed to get simulation results from the digital simulation engine. Please try again later.',
      );
    }

    // L'analyse IA (explication, risques, recommandations) complète les
    // chiffres du moteur ; son échec ne bloque jamais la simulation.
    const analysis = await this.analyzeSimulation(
      campaign,
      parameters,
      result,
      user.companyId,
    );

    return this.prisma.digitalSimulation.create({
      data: {
        campaignId: campaign.id,
        // `parameters` combine des enums Prisma et des interfaces locales :
        // structurellement du JSON valide, mais pas nominalement compatible
        // avec `Prisma.InputJsonValue` (absence de signature d'index sur les
        // interfaces). Cast explicite, valeur déjà entièrement sérialisable.
        inputSnapshot: parameters as unknown as Prisma.InputJsonValue,
        predictedReach: result.predictedReach,
        predictedEngagementRate: result.predictedEngagementRate,
        predictedCtr: result.predictedCtr,
        predictedRoas: result.predictedRoas,
        narrativeSummary: analysis?.summary ?? result.narrativeSummary,
        warnings: result.warnings,
        avgCpc: result.avgCpc,
        costPerAcquisition: result.costPerAcquisition,
        conversionRate: result.conversionRate,
        scenarios: result.scenarios as unknown as Prisma.InputJsonValue,
        channelBreakdown:
          result.channelBreakdown as unknown as Prisma.InputJsonValue,
        weeklySeries: result.weeklySeries as unknown as Prisma.InputJsonValue,
        ...(analysis && {
          aiAnalysis: analysis as unknown as Prisma.InputJsonValue,
        }),
      },
    });
  }

  /**
   * Fait expliquer la simulation par l'assistant IA. `null` si le service
   * n'est pas configuré ou échoue : la simulation reste enregistrée avec le
   * texte de repli du moteur.
   */
  private async analyzeSimulation(
    campaign: Campaign,
    parameters: DigitalSimulationParameters,
    result: DigitalSimulationResult,
    companyId: string | null,
  ): Promise<SimulationAnalysis | null> {
    try {
      const company = companyId
        ? await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { name: true, businessSector: true, address: true },
          })
        : null;
      const toDay = (date: Date) => date.toISOString().slice(0, 10);

      return await this.simulationAnalysis.analyze({
        campaignName: campaign.name,
        objective: parameters.objective,
        budget: {
          amount: parameters.budget.amount,
          allocation: parameters.budget.allocation,
        },
        startDate: toDay(campaign.startDate),
        endDate: toDay(campaign.endDate),
        audience: parameters.audience,
        channels: parameters.channels.map((channel) => channel.platform),
        ...(company && { companyProfile: company }),
        results: {
          predictedReach: result.predictedReach,
          predictedEngagementRate: result.predictedEngagementRate,
          predictedCtr: result.predictedCtr,
          predictedRoas: result.predictedRoas,
          avgCpc: result.avgCpc,
          costPerAcquisition: result.costPerAcquisition,
          conversionRate: result.conversionRate,
          warnings: result.warnings,
        },
        scenarios: result.scenarios,
        channelBreakdown: result.channelBreakdown,
      });
    } catch (error) {
      this.logger.warn(
        `Simulation saved without AI analysis for campaign ${campaign.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async getSimulations(
    campaignId: string,
    user: AuthenticatedUser,
    page: number,
    limit: number,
  ) {
    const campaign = await this.validateDigitalCampaignAccess(campaignId, user);

    const skip = (page - 1) * limit;
    const where = { campaignId: campaign.id };
    const [items, total] = await Promise.all([
      this.prisma.digitalSimulation.findMany({
        where,
        skip,
        take: limit,
        orderBy: { simulatedAt: 'desc' },
      }),
      this.prisma.digitalSimulation.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ---------- Private helpers ----------

  /** Compte ACTIF le plus récent de l'entreprise, par plateforme. */
  private async activeAccountsByPlatform(
    companyId: string,
  ): Promise<Map<SocialPlatform, { id: string }>> {
    const accounts =
      (await this.prisma.socialAccount.findMany({
        where: { companyId, status: SocialAccountStatus.ACTIVE },
        orderBy: { createdAt: 'desc' },
        select: { id: true, platform: true },
      })) ?? [];
    const byPlatform = new Map<SocialPlatform, { id: string }>();
    for (const account of accounts) {
      if (!byPlatform.has(account.platform)) {
        byPlatform.set(account.platform, { id: account.id });
      }
    }
    return byPlatform;
  }

  private async validateDigitalCampaignAccess(
    campaignId: string,
    user: AuthenticatedUser,
  ): Promise<Campaign> {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to manage a digital campaign.',
      );
    }

    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, launchedBy: { companyId: user.companyId } },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }
    if (campaign.type !== CampaignType.DIGITAL) {
      throw new BadRequestException('This campaign is not a digital campaign.');
    }

    return campaign;
  }

  private validateEditable(campaign: Campaign): void {
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException(
        'Digital campaign details can only be edited while the campaign is in DRAFT status.',
      );
    }
  }
}
