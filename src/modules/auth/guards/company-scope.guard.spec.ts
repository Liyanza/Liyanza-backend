import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CompanyScopeGuard } from './company-scope.guard';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

describe('CompanyScopeGuard', () => {
  let guard: CompanyScopeGuard;

  const makeContext = (
    user: AuthenticatedUser | undefined,
    companyIdParam: string | undefined,
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user, params: { companyId: companyIdParam } }),
      }),
    }) as unknown as ExecutionContext;

  const user: AuthenticatedUser = {
    userId: 'u1',
    email: 'a@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  beforeEach(() => {
    guard = new CompanyScopeGuard();
  });

  it('should throw a plain Error if the route has no :companyId param (misconfiguration)', () => {
    expect(() => guard.canActivate(makeContext(user, undefined))).toThrow(
      'CompanyScopeGuard requires a route parameter ":companyId".',
    );
  });

  it('should allow access when params.companyId matches user.companyId', () => {
    expect(guard.canActivate(makeContext(user, 'company-1'))).toBe(true);
  });

  // RÉGRESSION (isolation multi-tenant) : un mismatch doit renvoyer 404, pas
  // 403 — pour ne pas révéler l'existence de l'entreprise ciblée.
  it('should throw NotFoundException (not Forbidden) when params.companyId does not match', () => {
    expect(() => guard.canActivate(makeContext(user, 'other-company'))).toThrow(
      NotFoundException,
    );
  });

  it('should throw NotFoundException if the user has no company', () => {
    expect(() =>
      guard.canActivate(makeContext({ ...user, companyId: null }, 'company-1')),
    ).toThrow(NotFoundException);
  });

  it('should throw NotFoundException if request.user is missing', () => {
    expect(() =>
      guard.canActivate(makeContext(undefined, 'company-1')),
    ).toThrow(NotFoundException);
  });
});
