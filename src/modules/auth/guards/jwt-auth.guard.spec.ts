import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: { getAllAndOverride: jest.Mock };

  // `JwtAuthGuard extends AuthGuard('jwt')` (mixin passport) : on espionne le
  // prototype parent RÉEL (celui effectivement hérité), pas un nouvel appel
  // à `AuthGuard('jwt')` qui produirait une classe distincte non mémoïsée.
  const parentProto = Object.getPrototypeOf(JwtAuthGuard.prototype) as {
    canActivate: (...args: unknown[]) => unknown;
  };

  const makeContext = (): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new JwtAuthGuard(reflector as unknown as Reflector);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('canActivate', () => {
    it('should bypass authentication entirely on a @Public() route, without calling the passport strategy', () => {
      reflector.getAllAndOverride.mockReturnValue(true);
      const superSpy = jest
        .spyOn(parentProto, 'canActivate')
        .mockReturnValue(true);

      expect(guard.canActivate(makeContext())).toBe(true);
      expect(superSpy).not.toHaveBeenCalled();
    });

    it('should delegate to the passport "jwt" strategy on a non-public route', () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const superSpy = jest
        .spyOn(parentProto, 'canActivate')
        .mockReturnValue(true);

      const context = makeContext();
      void guard.canActivate(context);

      expect(superSpy).toHaveBeenCalledWith(context);
    });
  });

  describe('handleRequest', () => {
    it('should return the user when authentication succeeds', () => {
      const user = { userId: 'u1' };
      expect(guard.handleRequest(null, user, null)).toBe(user);
    });

    it('should rethrow the original error when passport reports one', () => {
      const err = new Error('strategy failure');
      expect(() => guard.handleRequest(err, null, null)).toThrow(
        'strategy failure',
      );
    });

    it('should throw UnauthorizedException with the strategy info message when no user and no error', () => {
      expect(() =>
        guard.handleRequest(null, false, new Error('jwt expired')),
      ).toThrow(UnauthorizedException);
      expect(() =>
        guard.handleRequest(null, false, new Error('jwt expired')),
      ).toThrow('jwt expired');
    });

    it('should fall back to a generic message when info is not an Error', () => {
      expect(() => guard.handleRequest(null, false, undefined)).toThrow(
        'Authentication required.',
      );
    });
  });
});
