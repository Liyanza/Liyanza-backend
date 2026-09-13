import {
  Controller,
  Get,
  Post,
  Param,
  Body,
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
import { SimulationsService } from './simulations.service';
import { SoumettreReponsesDto } from './dto/soumettre-reponses.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('simulations')
@ApiBearerAuth()
@Controller()
export class SimulationsController {
  constructor(private readonly simulationsService: SimulationsService) {}

  /**
   * GET /questionnaires-simulation/questions
   * List all available questions (label, fieldType).
   * Accessible to all authenticated users.
   */
  @Get('questionnaires-simulation/questions')
  @ApiOperation({ summary: 'List all available simulation questions' })
  @ApiResponse({ status: 200, description: 'Questions (label, fieldType)' })
  async getQuestions() {
    return this.simulationsService.getQuestions();
  }

  /**
   * POST /campagnes/:id/simulations
   * Create a questionnaire, persist answers, call IA engine (mock), and save simulation.
   * Allowed: ADMIN, MARKETING_MANAGER
   */
  @Post('campagnes/:id/simulations')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit answers and run a campaign simulation' })
  @ApiResponse({ status: 201, description: 'Simulation created' })
  async createSimulation(
    @Param('id') campaignId: string,
    @Body() dto: SoumettreReponsesDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.simulationsService.createSimulation(campaignId, dto, req.user);
  }

  /**
   * GET /campagnes/:id/simulations
   * Retrieve the simulation history for a campaign.
   * Allowed: ADMIN, MARKETING_MANAGER
   */
  @Get('campagnes/:id/simulations')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @ApiOperation({ summary: 'Get the simulation history for a campaign' })
  @ApiResponse({ status: 200, description: 'Simulation history' })
  async getSimulations(
    @Param('id') campaignId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.simulationsService.getSimulations(campaignId, req.user);
  }
}
