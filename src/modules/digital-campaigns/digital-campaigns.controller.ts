import {
  Controller,
  Get,
  Put,
  Post,
  Param,
  Body,
  Query,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import { DigitalCampaignsService } from './digital-campaigns.service';
import { UpsertDigitalDetailsDto } from './dto/upsert-digital-details.dto';
import { SelectDigitalChannelsDto } from './dto/select-digital-channels.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

/**
 * Étapes 1-4 du formulaire de campagne digitale + simulation. Mêmes rôles
 * que `CanauxController` (BACK-204) : la création du contenu d'une campagne
 * (canaux compris) est ouverte au COMMUNITY_MANAGER, contrairement à la
 * création/liaison du compte Meta lui-même (`SocialAccountsModule`, réservée
 * ADMIN/MARKETING_MANAGER).
 */
@Controller('campagnes/:id')
export class DigitalCampaignsController {
  constructor(
    private readonly digitalCampaignsService: DigitalCampaignsService,
  ) {}

  @Put('digital-details')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  async upsertDetails(
    @Param('id') campaignId: string,
    @Body() dto: UpsertDigitalDetailsDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.digitalCampaignsService.upsertDetails(
      campaignId,
      dto,
      req.user,
    );
  }

  @Get('digital-details')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  async getDetails(
    @Param('id') campaignId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.digitalCampaignsService.getDetails(campaignId, req.user);
  }

  @Put('digital-details/channels')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  async selectChannels(
    @Param('id') campaignId: string,
    @Body() dto: SelectDigitalChannelsDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.digitalCampaignsService.selectChannels(
      campaignId,
      dto,
      req.user,
    );
  }

  @Post('simulations-digitales')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  async createSimulation(
    @Param('id') campaignId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.digitalCampaignsService.createSimulation(campaignId, req.user);
  }

  @Get('simulations-digitales')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  async getSimulations(
    @Param('id') campaignId: string,
    @Query() query: PaginationQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const { page = 1, limit = 10 } = query;
    return this.digitalCampaignsService.getSimulations(
      campaignId,
      req.user,
      page,
      limit,
    );
  }
}
