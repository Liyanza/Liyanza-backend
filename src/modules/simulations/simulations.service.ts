import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { SoumettreReponsesDto } from './dto/soumettre-reponses.dto';
import type { SimulationEngineInterface } from './clients/simulation-engine.interface';
import { SIMULATION_ENGINE_TOKEN } from './clients/simulation-engine.interface';
import { CampaignStatus } from '@prisma/client';

@Injectable()
export class SimulationsService {
  constructor(
    private prisma: PrismaService,
    @Inject(SIMULATION_ENGINE_TOKEN)
    private simulationEngine: SimulationEngineInterface,
  ) {}

  async getQuestions() {
    return this.prisma.question.findMany({
      select: {
        id: true,
        label: true,
        fieldType: true,
      },
      orderBy: { label: 'asc' },
    });
  }

  async createSimulation(
    campaignId: string,
    dto: SoumettreReponsesDto,
    user: AuthenticatedUser,
  ) {
    // 1. Validate campaign
    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id: campaignId,
        launchedBy: { companyId: user.companyId },
      },
      include: {
        launchedBy: true,
      },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }
    if (!user.companyId) {
      throw new ForbiddenException('You must belong to a company.');
    }
    assertSameCompany(user, campaign.launchedBy.companyId, 'Campaign');

    if (
      campaign.status === CampaignStatus.COMPLETED ||
      campaign.status === CampaignStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'Cannot simulate a completed or cancelled campaign.',
      );
    }

    // 2. Validate question IDs
    const questionIds = dto.reponses.map((r) => r.questionId);
    const existingQuestions = await this.prisma.question.findMany({
      where: { id: { in: questionIds } },
      select: { id: true },
    });
    const existingIds = new Set(existingQuestions.map((q) => q.id));
    const invalidIds = questionIds.filter((id) => !existingIds.has(id));
    if (invalidIds.length > 0) {
      throw new BadRequestException(
        `Invalid question IDs: ${invalidIds.join(', ')}`,
      );
    }

    // 3. Create questionnaire and answers
    const questionnaire = await this.prisma.$transaction(async (tx) => {
      const q = await tx.questionnaire.create({
        data: {
          completedAt: new Date(),
        },
      });

      await tx.simulationAnswer.createMany({
        data: dto.reponses.map((rep) => ({
          value: rep.value,
          questionnaireId: q.id,
          questionId: rep.questionId,
        })),
      });

      return q;
    });

    // 4. Prepare engine parameters
    const parameters = {
      campaignId: campaign.id, // store for later filtering
      campaignName: campaign.name,
      objective: campaign.objective,
      plannedBudget: campaign.plannedBudget.toNumber(), // convert Decimal to number
      answers: dto.reponses.map((r) => ({
        questionId: r.questionId,
        value: r.value,
      })),
    };

    // 5. Call IA engine
    let simulationResult;
    try {
      simulationResult = await this.simulationEngine.simulate(parameters);
    } catch (error) {
      console.error('Simulation engine error:', error);
      throw new InternalServerErrorException(
        'Failed to get simulation results from AI engine. Please try again later.',
      );
    }

    // 6. Persist simulation
    const simulation = await this.prisma.simulation.create({
      data: {
        estimatedBudget: simulationResult.estimatedBudget,
        expectedResults: simulationResult.expectedResults,
        simulatedAt: new Date(),
        parameters: parameters as any,
        questionnaireId: questionnaire.id,
      },
    });

    // 7. Return simulation with questionnaire and answers
    return this.prisma.simulation.findUnique({
      where: { id: simulation.id },
      include: {
        questionnaire: {
          include: {
            answers: {
              include: {
                question: true,
              },
            },
          },
        },
      },
    });
  }

  async getSimulations(campaignId: string, user: AuthenticatedUser) {
    // Verify campaign access
    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id: campaignId,
        launchedBy: { companyId: user.companyId },
      },
      include: { launchedBy: true },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }
    assertSameCompany(user, campaign.launchedBy.companyId, 'Campaign');

    // Since campaignId is not yet in the schema, we store it in parameters JSON.
    // We fetch all simulations and filter in memory.
    // This is a temporary workaround until we add campaignId to the Simulation model.
    const allSimulations = await this.prisma.simulation.findMany({
      include: {
        questionnaire: {
          include: {
            answers: {
              include: {
                question: true,
              },
            },
          },
        },
      },
      orderBy: { simulatedAt: 'desc' },
    });

    // Filter simulations where parameters.campaignId matches
    const filtered = allSimulations.filter(
      (sim) => (sim.parameters as any)?.campaignId === campaignId,
    );

    return filtered;
  }
}
