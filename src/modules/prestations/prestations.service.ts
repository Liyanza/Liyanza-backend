import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { CreatePrestationDto } from './dto/create-prestation.dto';
import { SoumettrePreuveDto } from './dto/soumettre-preuve.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { ValidationLinkResponseDto } from './dto/validation-link-response.dto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { parseDuration } from '../../common/utils/duration.util';
import { CampaignStatus, Role } from '@prisma/client';

@Injectable()
export class PrestationsService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
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

    return this.prisma.installation.create({
      data: {
        location: dto.location,
        plannedLatitude: dto.plannedLatitude,
        plannedLongitude: dto.plannedLongitude,
        plannedInstallationDate: plannedDate,
        status: 'PLANNED',
        campaignId: campaign.id,
        providerId: user.userId,
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

    this.validateCoordinates(dto.latitude, dto.longitude);

    const takenAt = new Date(dto.takenAt);
    if (isNaN(takenAt.getTime())) {
      throw new BadRequestException('Invalid takenAt date.');
    }

    const existingProof = await this.prisma.publicationProof.findUnique({
      where: { installationId },
    });
    if (existingProof) {
      throw new ConflictException(
        'A proof has already been submitted for this installation.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
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
          where: { id: installationId },
          data: { status: newStatus },
        });
        await tx.statusHistory.create({
          data: {
            previousStatus,
            newStatus,
            changedAt: new Date(),
            comment: `Proof submitted by ${user.email}`,
            installationId: installation.id,
          },
        });
      }

      return proof;
    });

    return result;
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

    if (installation.status === dto.status) {
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

    // Generate token
    const payload = { sub: installationId, type: 'validation' };
    const expiresIn =
      this.configService.get<string>('jwt.validationExpiration') ?? '7d';
    const token = this.jwtService.sign(payload);

    // Calculate expiration date
    const seconds = parseDuration(expiresIn);
    const expiresAt = new Date(Date.now() + seconds * 1000);

    // Build link
    const baseUrl = this.configService.get<string>('VALIDATION_BASE_URL');
    if (!baseUrl) {
      throw new InternalServerErrorException(
        'Validation base URL not configured.',
      );
    }
    const link = `${baseUrl}/${token}`;

    return new ValidationLinkResponseDto({
      link,
      token,
      expiresAt: expiresAt.toISOString(),
    });
  }
}
