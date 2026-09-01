import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import { PrestationsService } from './prestations.service';
import { CreatePrestationDto } from './dto/create-prestation.dto';
import { SoumettrePreuveDto } from './dto/soumettre-preuve.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@Controller()
export class PrestationsController {
  constructor(private readonly prestationsService: PrestationsService) {}

  /**
   * POST /campagnes/:id/prestations
   * Create a planned installation (prestation) for a campaign.
   * Allowed: ADMIN, MARKETING_MANAGER
   */
  @Post('campagnes/:id/prestations')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  async createPrestation(
    @Param('id') campaignId: string,
    @Body() dto: CreatePrestationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.prestationsService.createPrestation(campaignId, dto, req.user);
  }

  /**
   * POST /prestations/:id/preuve
   * Submit a publication proof (photo + geolocation) for an installation.
   * Allowed: PROVIDER (or ADMIN/MARKETING_MANAGER if needed, but we restrict to PROVIDER)
   */
  @Post('prestations/:id/preuve')
  @Roles(Role.PROVIDER) // Only provider can submit proof
  @HttpCode(HttpStatus.CREATED)
  async soumettrePreuve(
    @Param('id') installationId: string,
    @Body() dto: SoumettrePreuveDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.prestationsService.soumettrePreuve(
      installationId,
      dto,
      req.user,
    );
  }

  /**
   * PATCH /prestations/:id/statut
   * Update the status of an installation, automatically creating a StatusHistory entry.
   * Allowed: ADMIN, MARKETING_MANAGER
   */
  @Patch('prestations/:id/statut')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.OK)
  async updateStatus(
    @Param('id') installationId: string,
    @Body() dto: UpdateStatusDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.prestationsService.updateStatus(installationId, dto, req.user);
  }

  /**
   * GET /prestations/:id/historique
   * Retrieve the complete status history of an installation.
   * Allowed: ADMIN, MARKETING_MANAGER (and optionally PROVIDER for own? we'll allow both)
   */
  @Get('prestations/:id/historique')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.PROVIDER)
  async getHistorique(
    @Param('id') installationId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.prestationsService.getHistorique(installationId, req.user);
  }
}
