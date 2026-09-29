import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request as ExpressRequest } from 'express';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignDescriptionClient } from './clients/campaign-description.client';
import { DescribeCampaignDto } from './dto/describe-campaign.dto';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

/**
 * « Générer une description avec l'IA » de l'assistant de création : aucune
 * campagne n'existe encore à cette étape, d'où une route hors `campagnes/:id`.
 */
@ApiTags('digital-campaigns')
@ApiBearerAuth()
@Controller('campagnes')
export class CampaignDescriptionController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CampaignDescriptionClient,
  ) {}

  @Post('description-ia')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Draft a campaign description with the AI' })
  @ApiResponse({ status: 200, description: '{ description }' })
  @ApiResponse({ status: 503, description: 'AI service unavailable' })
  async describe(
    @Body() dto: DescribeCampaignDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const company = req.user.companyId
      ? await this.prisma.company.findUnique({
          where: { id: req.user.companyId },
          select: { name: true, businessSector: true, address: true },
        })
      : null;
    let description: string | null;
    try {
      description = await this.client.describe({
        name: dto.name,
        product: dto.product,
        ...(dto.objective && { objective: dto.objective }),
        ...(company && { companyProfile: company }),
      });
    } catch {
      description = null;
    }
    if (!description) {
      throw new ServiceUnavailableException(
        'The AI description is temporarily unavailable. Please try again in a moment.',
      );
    }
    return { description };
  }
}
