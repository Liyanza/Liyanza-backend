import {
  Controller,
  Patch,
  Get,
  Param,
  Body,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import { DiffusionsService } from './diffusions.service';
import { UpdateDiffusionReelleDto } from './dto/update-diffusion-reelle.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@Controller()
export class DiffusionsController {
  constructor(private readonly diffusionsService: DiffusionsService) {}

  /**
   * PATCH /diffusions/:id/constat
   * Updates the actual broadcast time and audio proof.
   * Reserved for ADMIN and MARKETING_MANAGER roles.
   */
  @Patch('diffusions/:id/constat')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.OK)
  async updateConstat(
    @Param('id') id: string,
    @Body() dto: UpdateDiffusionReelleDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.diffusionsService.updateConstat(id, dto, req.user);
  }

  /**
   * GET /campagnes/:id/rapport-conformite
   * Generates the compliance report for a given campaign.
   */
  @Get('campagnes/:id/rapport-conformite')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.OK)
  async getRapportConformite(
    @Param('id') campaignId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.diffusionsService.getRapportConformite(campaignId, req.user);
  }
}
