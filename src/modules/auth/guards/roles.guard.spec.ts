import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: { getAllAndOverride: jest.Mock };

  const makeContext = (user?: AuthenticatedUser): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('should allow access when no @Roles() is declared on the handler/class', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(
      guard.canActivate(
        makeContext({
          userId: 'u1',
          email: 'a@test.com',
          role: Role.PROVIDER,
          companyId: 'c1',
        }),
      ),
    ).toBe(true);
  });

  it('should allow access when @Roles() is an empty array', () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    expect(
      guard.canActivate(
        makeContext({
          userId: 'u1',
          email: 'a@test.com',
          role: Role.PROVIDER,
          companyId: 'c1',
        }),
      ),
    ).toBe(true);
  });

  // Défense en profondeur : si JwtAuthGuard n'a pas tourné avant (mauvais
  // ordre d'enregistrement), request.user est absent — refuser plutôt que
  // de planter sur `user.role`.
  it('should throw ForbiddenException if request.user is missing even though roles are required', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('should allow access when the user role is in the required list', () => {
    reflector.getAllAndOverride.mockReturnValue([
      Role.ADMIN,
      Role.MARKETING_MANAGER,
    ]);
    expect(
      guard.canActivate(
        makeContext({
          userId: 'u1',
          email: 'a@test.com',
          role: Role.MARKETING_MANAGER,
          companyId: 'c1',
        }),
      ),
    ).toBe(true);
  });

  it('should throw ForbiddenException when the user role is not in the required list', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    expect(() =>
      guard.canActivate(
        makeContext({
          userId: 'u1',
          email: 'a@test.com',
          role: Role.PROVIDER,
          companyId: 'c1',
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});
