/* eslint-disable @typescript-eslint/unbound-method */
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { DemoReadOnlyGuard, DEMO_READ_ONLY_CODE } from './demo-read-only.guard';
import { DEMO_ALLOWED_KEY } from '../decorators/demo-allowed.decorator';
import { AuthController } from '../auth.controller';
import { AssistantIController } from '../../assistant-ia/assistant-ia.controller';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

const demoUser: AuthenticatedUser = {
  userId: 'demo-user',
  email: 'visiteur@demo.kiyanza.com',
  role: Role.ADMIN,
  companyId: 'demo-company',
  demo: true,
};
const realUser: AuthenticatedUser = { ...demoUser, demo: false };

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type Handler = Function;

function contextFor(
  method: string,
  user: AuthenticatedUser | undefined,
  handler: Handler = () => undefined,
  controller: Handler = class {},
): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ method, user }) }),
  } as unknown as ExecutionContext;
}

describe('DemoReadOnlyGuard', () => {
  const reflector = new Reflector();
  const guard = new DemoReadOnlyGuard(reflector);

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'should block %s for a demo session with a DEMO_READ_ONLY 403',
    (method) => {
      let error: unknown;
      try {
        guard.canActivate(contextFor(method, demoUser));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(403);
      const body = httpError.getResponse() as { code: string; message: string };
      expect(body.code).toBe(DEMO_READ_ONLY_CODE);
      expect(body.message).toContain('démo');
    },
  );

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'should let a demo session read (%s)',
    (method) => {
      expect(guard.canActivate(contextFor(method, demoUser))).toBe(true);
    },
  );

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'should never affect a normal session (%s)',
    (method) => {
      expect(guard.canActivate(contextFor(method, realUser))).toBe(true);
      const { demo: _demo, ...withoutFlag } = realUser;
      void _demo;
      expect(guard.canActivate(contextFor(method, withoutFlag))).toBe(true);
    },
  );

  it('should not affect public routes (no authenticated user)', () => {
    expect(guard.canActivate(contextFor('POST', undefined))).toBe(true);
  });

  describe('allow-list (@DemoAllowed)', () => {
    const allowed: Array<[string, Handler, Handler, string]> = [
      [
        'POST /auth/logout',
        AuthController,
        AuthController.prototype.logout,
        'POST',
      ],
      [
        'POST /conversations',
        AssistantIController,
        AssistantIController.prototype.createConversation,
        'POST',
      ],
      [
        'POST /conversations/:id/messages',
        AssistantIController,
        AssistantIController.prototype.envoyerMessage,
        'POST',
      ],
      [
        'POST /conversations/:id/messages/stream',
        AssistantIController,
        AssistantIController.prototype.envoyerMessageStream,
        'POST',
      ],
      [
        'POST /conversations/:id/regenerate',
        AssistantIController,
        AssistantIController.prototype.regenererDerniereReponse,
        'POST',
      ],
      [
        'PATCH /conversations/:id/messages/:messageId/feedback',
        AssistantIController,
        AssistantIController.prototype.setMessageFeedback,
        'PATCH',
      ],
    ];

    it.each(allowed)(
      'should allow %s for a demo session',
      (_route, controller, handler, method) => {
        expect(reflector.get(DEMO_ALLOWED_KEY, handler)).toBe(true);
        expect(
          guard.canActivate(contextFor(method, demoUser, handler, controller)),
        ).toBe(true);
      },
    );

    it('should keep renaming/deleting a conversation forbidden', () => {
      for (const [handler, method] of [
        [AssistantIController.prototype.renameConversation, 'PATCH'],
        [AssistantIController.prototype.deleteConversation, 'DELETE'],
      ] as const) {
        expect(() =>
          guard.canActivate(
            contextFor(method, demoUser, handler, AssistantIController),
          ),
        ).toThrow(HttpException);
      }
    });
  });
});
