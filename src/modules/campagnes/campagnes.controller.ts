import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Request,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role, CampaignStatus } from '@prisma/client';
import { CampagnesService } from './campagnes.service';
import { CreateCampagneDto } from './dto/create-campagne.dto';
import { UpdateCampagneDto } from './dto/update-campagne.dto';
import { LancerCampagneDto } from './dto/lancer-campagne.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@Controller('campagnes')
export class CampagnesController {
  constructor(private readonly campagnesService: CampagnesService) {}

  @Post()
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateCampagneDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.campagnesService.create(dto, req.user);
  }

  @Get()
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  async findAll(
    @Request() req: AuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('status') status?: CampaignStatus,
  ) {
    return this.campagnesService.findAll(req.user, page, limit, status);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  async findOne(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.campagnesService.findOne(id, req.user);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
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
  async lancer(
    @Param('id') id: string,
    @Body() dto: LancerCampagneDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.campagnesService.lancer(id, dto, req.user);
  }
}
