import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { LoggerService } from '../../modules/logger/logger.service';
import { RequestContextService } from '../context/request-context.service';
import { PlanLimitException } from '../../modules/billing/plan-limits';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  const run = (exception: unknown) => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ headersSent: false, status }),
        getRequest: () => ({ url: '/campagnes' }),
      }),
    } as unknown as ArgumentsHost;
    const filter = new AllExceptionsFilter(
      { error: jest.fn() } as unknown as LoggerService,
      { getRequestId: () => 'req-1' } as unknown as RequestContextService,
    );
    filter.catch(exception, host);
    return {
      status,
      body: (json.mock.calls[0] as [Record<string, unknown>])[0],
    };
  };

  it('should relay the PLAN_LIMIT fields the web relies on', () => {
    const { status, body } = run(new PlanLimitException('campaigns', 'PRO', 1));

    expect(status).toHaveBeenCalledWith(403);
    expect(body).toMatchObject({
      statusCode: 403,
      code: 'PLAN_LIMIT',
      feature: 'campaigns',
      requiredPlan: 'PRO',
      limit: 1,
      message: expect.any(String) as string,
      requestId: 'req-1',
    });
  });

  it('should keep a null limit and add nothing to ordinary HTTP errors', () => {
    expect(
      run(new PlanLimitException('aiAdvanced', 'PRO', null)).body,
    ).toHaveProperty('limit', null);

    const { body } = run(new BadRequestException('Nope.'));
    expect(body).not.toHaveProperty('code');
    expect(body).not.toHaveProperty('error');
    expect(body.message).toBe('Nope.');
  });
});
