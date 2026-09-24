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
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PrestationsService } from './prestations.service';
import { CreatePrestationDto } from './dto/create-prestation.dto';
import { SoumettrePreuveDto } from './dto/soumettre-preuve.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { ReviewProofDto } from './dto/review-proof.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ValidationLinkResponseDto } from './dto/validation-link-response.dto';
import { ValidationConsultationResponseDto } from './dto/validation-consultation-response.dto';
import { ConsommerValidationDto } from './dto/consommer-validation.dto';
import { ProofLinkResponseDto } from './dto/proof-link-response.dto';
import { ProofLinkConsultationResponseDto } from './dto/proof-link-consultation-response.dto';

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
  @ApiBearerAuth()
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
  @ApiBearerAuth()
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
  @ApiBearerAuth()
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
   * PATCH /prestations/:id/preuve/validation
   * Validate or reject the proof received for an installation.
   * Allowed: ADMIN, MARKETING_MANAGER
   */
  @Patch('prestations/:id/preuve/validation')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Validate or reject an installation proof' })
  @ApiResponse({ status: 200, description: 'Proof reviewed' })
  @ApiResponse({ status: 404, description: 'Installation or proof not found' })
  @ApiResponse({ status: 409, description: 'Proof already reviewed' })
  async reviewProof(
    @Param('id') installationId: string,
    @Body() dto: ReviewProofDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.prestationsService.reviewProof(installationId, dto, req.user);
  }

  /**
   * GET /prestations/:id/historique
   * Retrieve the complete status history of an installation.
   * Allowed: ADMIN, MARKETING_MANAGER, PROVIDER
   */
  @Get('prestations/:id/historique')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.PROVIDER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get status history of an installation' })
  @ApiResponse({ status: 200, description: 'History retrieved' })
  async getHistorique(
    @Param('id') installationId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.prestationsService.getHistorique(installationId, req.user);
  }

  /**
   * GET /prestations
   * List every installation of the caller's company (with its proof, if
   * any, and the computed distance to the planned location) — feeds the
   * terrain tracking map.
   * Allowed: ADMIN, MARKETING_MANAGER, COMMUNITY_MANAGER
   */
  @Get('prestations')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "List the company's installations for the terrain map",
  })
  @ApiResponse({
    status: 200,
    description: 'Installations with proof and distance',
  })
  async listInstallations(@Request() req: AuthenticatedRequest) {
    return this.prestationsService.listInstallations(req.user);
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
  @ApiBearerAuth()
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
   * GET /prestations/lien-validation/:token
   *
   * BACK-308 : endpoint public de **consultation seule** — le publicitaire
   * externe doit pouvoir revoir la preuve avant de la valider, sans
   * consommer le lien à usage unique (contrairement à l'ancien
   * comportement où `consumeValidationLink` faisait les deux en un seul
   * appel). Throttle dédié : écart de sécurité corrigé au passage — cette
   * route publique n'en avait aucun (cf. `.claude/skills/liyanza-security-guardrails/SKILL.md` §10).
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('prestations/lien-validation/:token')
  @ApiOperation({
    summary: 'Consult a validation link (read-only, does not consume it)',
  })
  @ApiResponse({ status: 200, type: ValidationConsultationResponseDto })
  async consulterLienValidation(
    @Param('token') token: string,
  ): Promise<ValidationConsultationResponseDto> {
    return this.prestationsService.consulterLienValidation(token);
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
   *
   * BACK-308 : accepte désormais un `commentaire` optionnel, persisté sur
   * la preuve. Throttle dédié ajouté (même écart que ci-dessus).
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('prestations/lien-validation/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Consume a (single-use) external validation link',
  })
  @ApiResponse({ status: 200, description: 'Proof validated' })
  async consumeValidationLink(
    @Param('token') token: string,
    @Body() dto: ConsommerValidationDto,
  ) {
    return this.prestationsService.consumeValidationLink(
      token,
      dto.commentaire,
    );
  }

  /**
   * POST /prestations/:id/lien-preuve
   * Generate a single-use, no-account link sent to the external
   * prestataire (poster installer) so THEY can submit the proof
   * themselves — distinct from `lien-validation`, which lets an external
   * reviewer re-check a proof that already exists.
   * Allowed: ADMIN, MARKETING_MANAGER
   */
  @Post('prestations/:id/lien-preuve')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Generate a no-account proof-submission link for an installation',
  })
  @ApiResponse({ status: 201, type: ProofLinkResponseDto })
  async generateProofLink(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<ProofLinkResponseDto> {
    return this.prestationsService.generateProofLink(id, req.user);
  }

  /**
   * GET /prestations/lien-preuve/:token
   * Public, read-only: what the prestataire sees before submitting
   * anything (location, campaign, whether it's already done).
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('prestations/lien-preuve/:token')
  @ApiOperation({
    summary: 'Consult a proof-submission link (read-only, does not consume it)',
  })
  @ApiResponse({ status: 200, type: ProofLinkConsultationResponseDto })
  async consulterLienPreuve(
    @Param('token') token: string,
  ): Promise<ProofLinkConsultationResponseDto> {
    return this.prestationsService.consulterLienPreuve(token);
  }

  /**
   * POST /prestations/lien-preuve/:token
   * Public: consumes the single-use link and creates the proof. No JWT,
   * no user account — the token itself is the authorization, same
   * security pattern as the validation link (signed + Redis-tracked jti).
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('prestations/lien-preuve/:token')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Consume a (single-use) proof-submission link and create the proof',
  })
  @ApiResponse({ status: 201, description: 'Proof created' })
  async soumettrePreuveViaLien(
    @Param('token') token: string,
    @Body() dto: SoumettrePreuveDto,
  ) {
    return this.prestationsService.soumettrePreuveViaLien(token, dto);
  }
}
