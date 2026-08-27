import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AssociateChannelsDto } from './dto/associate-channels.dto';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { ScheduleQueryDto } from './dto/schedule-query.dto';
import { CampaignStatus } from '@prisma/client';

@Injectable()
export class CanauxService {
  constructor(private prisma: PrismaService) {}

  /**
   * Associates one or more channels (radio/poster/flyer) with a campaign.
   * Verifies campaign existence, company ownership, and that the campaign
   * is not already COMPLETED or CANCELLED.
   */
  async associateChannels(
    campaignId: string,
    dto: AssociateChannelsDto,
    user: AuthenticatedUser,
  ) {
    const campaign = await this.validateCampaignAccess(campaignId, user);
    this.validateCampaignNotTerminated(campaign);

    // Create all channels in a single transaction
    const createdChannels = await this.prisma.$transaction(
      dto.channels.map((channel) =>
        this.prisma.advertisingChannel.create({
          data: {
            radio: channel.radio,
            poster: channel.poster,
            flyer: channel.flyer,
            campaignId: campaign.id,
          },
        }),
      ),
    );

    return createdChannels;
  }

  /**
   * Creates the planned broadcast schedule for a campaign.
   * Verifies that all provided channel IDs belong to the campaign.
   */
  async createSchedule(
    campaignId: string,
    dto: CreateScheduleDto,
    user: AuthenticatedUser,
  ) {
    const campaign = await this.validateCampaignAccess(campaignId, user);
    this.validateCampaignNotTerminated(campaign);

    // Fetch existing channel IDs for this campaign
    const existingChannelIds = (
      await this.prisma.advertisingChannel.findMany({
        where: { campaignId: campaign.id },
        select: { id: true },
      })
    ).map((c) => c.id);

    // Validate that every broadcast references a valid channel
    const invalidChannelIds = dto.broadcasts
      .map((b) => b.channelId)
      .filter((id) => !existingChannelIds.includes(id));

    if (invalidChannelIds.length > 0) {
      throw new BadRequestException(
        `The following channel IDs do not belong to this campaign: ${invalidChannelIds.join(', ')}`,
      );
    }

    // Create all broadcasts in a single transaction
    const createdBroadcasts = await this.prisma.$transaction(
      dto.broadcasts.map((broadcast) =>
        this.prisma.broadcast.create({
          data: {
            mediaType: broadcast.mediaType,
            scheduledAt: new Date(broadcast.scheduledAt),
            duration: broadcast.duration,
            status: 'PLANNED', // Planned status for forecasts
            campaignId: campaign.id,
            channelId: broadcast.channelId,
          },
        }),
      ),
    );

    return createdBroadcasts;
  }

  /**
   * Retrieves the schedule of broadcasts for a campaign with pagination and filters.
   */
  async getSchedule(
    campaignId: string,
    query: ScheduleQueryDto,
    user: AuthenticatedUser,
  ) {
    // Ensure campaign exists and user has access
    await this.validateCampaignAccess(campaignId, user);

    const { channelId, dateFrom, dateTo, page, limit } = query;
    const skip = (page - 1) * limit;

    const where: any = {
      campaignId: campaignId,
    };

    if (channelId) {
      where.channelId = channelId;
    }

    if (dateFrom || dateTo) {
      where.scheduledAt = {};
      if (dateFrom) {
        where.scheduledAt.gte = new Date(dateFrom);
      }
      if (dateTo) {
        where.scheduledAt.lte = new Date(dateTo);
      }
    }

    const [items, total] = await Promise.all([
      this.prisma.broadcast.findMany({
        where,
        skip,
        take: limit,
        orderBy: { scheduledAt: 'asc' },
        include: {
          channel: true,
        },
      }),
      this.prisma.broadcast.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ---------- Private Helpers ----------

  private async validateCampaignAccess(
    campaignId: string,
    user: AuthenticatedUser,
  ) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to manage campaign channels.',
      );
    }

    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id: campaignId,
        launchedBy: {
          companyId: user.companyId,
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }

    return campaign;
  }

  private validateCampaignNotTerminated(campaign: any) {
    if (
      campaign.status === CampaignStatus.COMPLETED ||
      campaign.status === CampaignStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'Cannot modify a campaign that is already completed or cancelled.',
      );
    }
  }
}
