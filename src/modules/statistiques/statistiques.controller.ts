import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  Res,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Response } from 'express'; // ✅ import type
import { Role } from '@prisma/client';
import { StatistiquesService } from './statistiques.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { StatistiqueFilterDto } from './dto/statistique-filter.dto';
import { RapportQueryDto } from './dto/rapport-query.dto';

interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

@Controller()
export class StatistiquesController {
  constructor(private readonly statsService: StatistiquesService) {}

  @Get('campagnes/:id/statistiques')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  async getCampagneStatistiques(
    @Param('id') campaignId: string,
    @Query() filters: StatistiqueFilterDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.statsService.getCampagneStatistiques(
      campaignId,
      req.user,
      filters,
    );
  }

  @Get('dashboard')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  async getDashboard(@Request() req: AuthenticatedRequest) {
    return this.statsService.getDashboard(req.user);
  }

  @Get('rapports')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  async exportRapport(
    @Query() query: RapportQueryDto,
    @Request() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    const { format, campagneId } = query;
    const bufferOrCsv = await this.statsService.generateRapport(
      req.user,
      format,
      campagneId,
    );

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=rapport_${Date.now()}.csv`,
      );
      return res.status(HttpStatus.OK).send(bufferOrCsv);
    }

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=rapport_${Date.now()}.pdf`,
      );
      return res.status(HttpStatus.OK).send(bufferOrCsv);
    }

    throw new InternalServerErrorException('Unsupported format.');
  }
}
