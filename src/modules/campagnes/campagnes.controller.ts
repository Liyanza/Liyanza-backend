import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Request,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CampagnesService } from './campagnes.service';
import { CreateCampagneDto } from './dto/create-campagne.dto';
import { UpdateCampagneDto } from './dto/update-campagne.dto';
import { LancerCampagneDto } from './dto/lancer-campagne.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { CampagneQueryDto } from './dto/campagne-query.dto';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('campagnes')
@ApiBearerAuth()
@Controller('campagnes')
export class CampagnesController {
  constructor(private readonly campagnesService: CampagnesService) {}

  // BACK-501 (campagnes digitales) : la création/consultation d'une campagne
  // est ouverte au COMMUNITY_MANAGER, même principe que
  // `DigitalCampaignsController` (créer le contenu d'une campagne n'est pas
  // une action d'infrastructure). `update`/`lancer` ci-dessous restent
  // réservés à ADMIN/MARKETING_MANAGER : faire évoluer/lancer une campagne
  // déjà créée est un geste différent, jamais appelé par l'assistant de
  // création digitale.
  @Post()
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a campaign (status DRAFT)' })
  @ApiResponse({ status: 201, description: 'Campaign created' })
  async create(
    @Body() dto: CreateCampagneDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.campagnesService.create(dto, req.user);
  }

  @Get()
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  @ApiOperation({ summary: "List the caller's company campaigns" })
  @ApiResponse({ status: 200, description: 'Paginated campaign list' })
  async findAll(
    @Request() req: AuthenticatedRequest,
    @Query() query: CampagneQueryDto,
  ) {
    const { page = 1, limit = 10, status, type } = query;
    return this.campagnesService.findAll(req.user, page, limit, status, type);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  @ApiOperation({ summary: 'Get a campaign by id' })
  @ApiResponse({ status: 200, description: 'Campaign found' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  async findOne(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.campagnesService.findOne(id, req.user);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @ApiOperation({ summary: 'Update campaign fields' })
  @ApiResponse({ status: 200, description: 'Campaign updated' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCampagneDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.campagnesService.update(id, dto, req.user);
  }

  @Post(':id/lancer')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Transition campaign status (DRAFT->PLANNED->IN_PROGRESS->COMPLETED/CANCELLED)',
  })
  @ApiResponse({ status: 200, description: 'Status transitioned' })
  @ApiResponse({
    status: 400,
    description: 'Invalid transition or campaign not complete enough',
  })
  async lancer(
    @Param('id') id: string,
    @Body() dto: LancerCampagneDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.campagnesService.lancer(id, dto, req.user);
  }
}
