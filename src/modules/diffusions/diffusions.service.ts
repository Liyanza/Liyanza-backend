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
import { BroadcastStatus } from '@prisma/client';

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

    const updateData: any = {
      status: BroadcastStatus.BROADCASTED,
    };
    if (dto.actualBroadcastAt) {
      updateData.actualBroadcastAt = new Date(dto.actualBroadcastAt);
    }
    if (dto.audioProof !== undefined) {
      updateData.audioProof = dto.audioProof;
    }

    return this.prisma.broadcast.update({
      where: { id },
      data: updateData,
    });
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

    for (const b of broadcasts) {
      let status: string;
      let ecartMinutes: number | null = null;

      if (b.actualBroadcastAt) {
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
    };
  }
}
