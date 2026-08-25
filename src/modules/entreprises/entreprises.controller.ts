import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Query,
  Request,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import { EntreprisesService } from './entreprises.service';
import { CreateEntrepriseDto } from './dto/create-entreprise.dto';
import { UpdateEntrepriseDto } from './dto/update-entreprise.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';

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

  @Get()
  @Roles(Role.ADMIN) // Reserved for admins (future SUPER_ADMIN)
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('name') name?: string,
    @Query('businessSector') businessSector?: string,
  ) {
    return this.entreprisesService.findAll(page, limit, {
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
