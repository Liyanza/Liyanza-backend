import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Query,
  Request,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import { EntreprisesService } from './entreprises.service';
import { CreateEntrepriseDto } from './dto/create-entreprise.dto';
import { UpdateEntrepriseDto } from './dto/update-entreprise.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { EntrepriseQueryDto } from './dto/entreprise-query.dto';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@Controller('entreprises')
export class EntreprisesController {
  constructor(private readonly entreprisesService: EntreprisesService) {}

  @Post()
  async create(
    @Body() createDto: CreateEntrepriseDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.entreprisesService.create(createDto, req.user);
  }

  /**
   * Retourne l'entreprise de l'appelant (paginée par cohérence d'API, mais
   * scopée à une seule entreprise — voir `EntreprisesService.findAll` pour
   * le détail du correctif de sécurité).
   */
  @Get()
  @Roles(Role.ADMIN)
  async findAll(
    @Request() req: AuthenticatedRequest,
    @Query() query: EntrepriseQueryDto,
  ) {
    const { page = 1, limit = 10, name, businessSector } = query;
    return this.entreprisesService.findAll(req.user, page, limit, {
      name,
      businessSector,
    });
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.entreprisesService.findOne(id, req.user);
  }

  @Patch(':id')
  @Roles(Role.ADMIN) // Only ADMIN can modify
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateEntrepriseDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.entreprisesService.update(id, updateDto, req.user);
  }
}
