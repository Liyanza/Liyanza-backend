import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalTokenGuard } from './internal-token.guard';

describe('InternalTokenGuard', () => {
  const EXPECTED_TOKEN = 'a'.repeat(64);

  const makeContext = (headers: Record<string, string>): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
      }),
    }) as unknown as ExecutionContext;

  const makeGuard = () => {
    const configService = {
      get: jest.fn().mockReturnValue(EXPECTED_TOKEN),
    } as unknown as ConfigService;
    return new InternalTokenGuard(configService);
  };

  it('should allow the request when the header matches the configured token', () => {
    const guard = makeGuard();
    expect(
      guard.canActivate(makeContext({ 'x-internal-token': EXPECTED_TOKEN })),
    ).toBe(true);
  });

  it('should reject when the header is missing', () => {
    const guard = makeGuard();
    expect(() => guard.canActivate(makeContext({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('should reject when the header does not match the configured token', () => {
    const guard = makeGuard();
    expect(() =>
      guard.canActivate(makeContext({ 'x-internal-token': 'wrong-token' })),
    ).toThrow(UnauthorizedException);
  });

  // RÉGRESSION : `timingSafeEqual` lève si les deux buffers n'ont pas la
  // même longueur — un token candidat plus court/long que l'attendu ne doit
  // jamais faire planter le guard (500), seulement le rejeter (401).
  it('should reject (not throw a 500) when the provided token has a different length', () => {
    const guard = makeGuard();
    expect(() =>
      guard.canActivate(makeContext({ 'x-internal-token': 'short' })),
    ).toThrow(UnauthorizedException);
  });
});
