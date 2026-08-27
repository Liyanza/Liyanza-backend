import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateCampagneDto } from './dto/create-campagne.dto';
import { UpdateCampagneDto } from './dto/update-campagne.dto';
import { LancerCampagneDto } from './dto/lancer-campagne.dto';
import { CampaignStatus } from '@prisma/client';
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
    const where: any = {
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

    // Prepare update data
    const updateData: any = {};
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

    return this.prisma.campaign.update({
      where: { id },
      data: updateData,
    });
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

    // If transitioning from DRAFT to PLANNED, ensure required fields are filled
    if (
      campaign.status === CampaignStatus.DRAFT &&
      dto.status === CampaignStatus.PLANNED
    ) {
      this.validateCampaignComplete(campaign);
    }

    // Perform the update
    return this.prisma.campaign.update({
      where: { id },
      data: { status: dto.status },
    });
  }

  /**
   * Validate that startDate <= endDate.
   */
  private validateDates(startDate: Date, endDate: Date): void {
    if (startDate > endDate) {
      throw new BadRequestException('Start date cannot be after end date.');
    }
  }

  /**
   * Validate that a campaign has all required fields before transitioning to PLANNED.
   */
  private validateCampaignComplete(campaign: any): void {
    if (!campaign.name) {
      throw new BadRequestException('Campaign name is required.');
    }
    if (!campaign.objective) {
      throw new BadRequestException('Campaign objective is required.');
    }
    if (!campaign.startDate) {
      throw new BadRequestException('Campaign start date is required.');
    }
    if (!campaign.endDate) {
      throw new BadRequestException('Campaign end date is required.');
    }
    if (campaign.plannedBudget <= 0) {
      throw new BadRequestException('Campaign planned budget must be > 0.');
    }
  }
}
