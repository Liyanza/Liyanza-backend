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
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrestationsService } from './prestations.service';
import { CreatePrestationDto } from './dto/create-prestation.dto';
import { SoumettrePreuveDto } from './dto/soumettre-preuve.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ValidationLinkResponseDto } from './dto/validation-link-response.dto';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('prestations')
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
  @ApiOperation({ summary: 'Create a planned installation for a campaign' })
  @ApiResponse({ status: 201, description: 'Installation created' })
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
  @ApiOperation({ summary: 'Submit a publication proof for an installation' })
  @ApiResponse({ status: 201, description: 'Proof submitted' })
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
  @ApiOperation({ summary: 'Update installation status with history' })
  @ApiResponse({ status: 200, description: 'Status updated' })
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
   * Allowed: ADMIN, MARKETING_MANAGER, PROVIDER
   */
  @Get('prestations/:id/historique')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.PROVIDER)
  @ApiOperation({ summary: 'Get status history of an installation' })
  @ApiResponse({ status: 200, description: 'History retrieved' })
  async getHistorique(
    @Param('id') installationId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.prestationsService.getHistorique(installationId, req.user);
  }

  /**
   * POST /prestations/:id/lien-validation
   * Generate an external validation link for an installation.
   * Allowed: ADMIN, MARKETING_MANAGER
   *
   * CORRECTIF AUDIT (majeur #5) : la route était auparavant déclarée
   * `@Post(':id/lien-validation')`, sans le préfixe `prestations/` utilisé
   * par tous les autres handlers de ce contrôleur (`@Controller()` n'a pas
   * de préfixe global). Elle se retrouvait donc montée à la racine de
   * l'API (`POST /:id/lien-validation`), au lieu de `POST
   * /prestations/:id/lien-validation`.
   */
  @Post('prestations/:id/lien-validation')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Generate a validation link for an external publicitaire',
  })
  @ApiResponse({ status: 201, type: ValidationLinkResponseDto })
  async generateValidationLink(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<ValidationLinkResponseDto> {
    return this.prestationsService.generateValidationLink(id, req.user);
  }

  /**
   * POST /prestations/lien-validation/:token
   *
   * CORRECTIF AUDIT (majeur #6) : endpoint public consommant le lien de
   * validation généré ci-dessus. Le token porte lui-même la preuve
   * d'autorisation (signé avec un secret dédié `jwt.validationSecret`,
   * distinct du secret d'authentification applicatif) — aucun compte
   * utilisateur n'est requis côté publicitaire externe. La sémantique
   * "single-use" est appliquée côté service via un `jti` suivi dans Redis.
   */
  @Public()
  @Post('prestations/lien-validation/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Consume a (single-use) external validation link',
  })
  @ApiResponse({ status: 200, description: 'Proof validated' })
  async consumeValidationLink(@Param('token') token: string) {
    return this.prestationsService.consumeValidationLink(token);
  }
}
