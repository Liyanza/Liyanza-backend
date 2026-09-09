import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  Request,
  Redirect,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { QrCodeService } from './qr-code.service';
import { CreateQrCodeDto } from './dto/create-qr-code.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('qr-code')
@Controller()
export class QrCodeController {
  constructor(private readonly qrCodeService: QrCodeService) {}

  @Post('campagnes/:id/qr-codes')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Generate a unique QR code for a campaign zone/support',
  })
  @ApiResponse({ status: 201, description: 'QR code created' })
  async create(
    @Param('id') campaignId: string,
    @Body() dto: CreateQrCodeDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.qrCodeService.create(campaignId, dto, req.user);
  }

  @Get('campagnes/:id/qr-codes')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  @ApiOperation({
    summary: 'List a campaign QR codes with scan counts, paginated',
  })
  @ApiResponse({ status: 200, description: 'Paginated QR code list' })
  async findAll(
    @Param('id') campaignId: string,
    @Query() query: PaginationQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.qrCodeService.findAllForCampaign(campaignId, query, req.user);
  }

  /**
   * Route publique à fort potentiel d'abus (spam/scraping) — throttle dédié
   * dès ce ticket, pas reporté en Phase 4 (voir
   * .claude/skills/liyanza-security-guardrails/SKILL.md §10). La cible de
   * redirection est TOUJOURS résolue depuis la base par `code` opaque
   * (jamais fournie par l'appelant) : pas de vecteur d'open-redirect.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('qr/:code')
  @Redirect()
  @ApiOperation({
    summary: 'Resolve a QR code scan and redirect to its target URL',
  })
  @ApiResponse({ status: 302, description: 'Redirect to target URL' })
  async scan(@Param('code') code: string) {
    const url = await this.qrCodeService.resolveScan(code);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
