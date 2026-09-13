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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CanauxService } from './canaux.service';
import { AssociateChannelsDto } from './dto/associate-channels.dto';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { ScheduleQueryDto } from './dto/schedule-query.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('canaux')
@ApiBearerAuth()
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
  @ApiOperation({ summary: 'Associate one or more channels with a campaign' })
  @ApiResponse({ status: 201, description: 'Channels created' })
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
  @ApiOperation({ summary: 'Create the planned broadcast schedule' })
  @ApiResponse({ status: 201, description: 'Broadcasts scheduled' })
  @ApiResponse({
    status: 400,
    description: 'A channelId does not belong to this campaign',
  })
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
  @ApiOperation({
    summary: 'View the broadcast schedule (paginated, filterable)',
  })
  @ApiResponse({ status: 200, description: 'Paginated broadcast schedule' })
  async getSchedule(
    @Param('id') campaignId: string,
    @Query() query: ScheduleQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.canauxService.getSchedule(campaignId, query, req.user);
  }
}
