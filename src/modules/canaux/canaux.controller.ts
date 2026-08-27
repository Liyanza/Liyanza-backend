import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import { CanauxService } from './canaux.service';
import { AssociateChannelsDto } from './dto/associate-channels.dto';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { ScheduleQueryDto } from './dto/schedule-query.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@Controller('campagnes')
export class CanauxController {
  constructor(private readonly canauxService: CanauxService) {}

  /**
   * POST /campagnes/:id/canaux
   * Associate one or more channels with a campaign.
   */
  @Post(':id/canaux')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  async associateChannels(
    @Param('id') campaignId: string,
    @Body() dto: AssociateChannelsDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.canauxService.associateChannels(campaignId, dto, req.user);
  }

  /**
   * POST /campagnes/:id/planning
   * Create the planned broadcast schedule.
   */
  @Post(':id/planning')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  async createSchedule(
    @Param('id') campaignId: string,
    @Body() dto: CreateScheduleDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.canauxService.createSchedule(campaignId, dto, req.user);
  }

  /**
   * GET /campagnes/:id/planning
   * View the broadcast schedule with pagination and filters.
   */
  @Get(':id/planning')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  async getSchedule(
    @Param('id') campaignId: string,
    @Query() query: ScheduleQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.canauxService.getSchedule(campaignId, query, req.user);
  }
}
