import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedUser } from '../types/auth.types';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  let reflector: jest.Mocked<Reflector>;
  let guard: RolesGuard;

  const contextFor = (role?: Role) => {
    const handler = jest.fn();
    const controller = jest.fn();
    const user = role ? ({ role } as AuthenticatedUser) : undefined;
    return {
      context: {
        getHandler: () => handler,
        getClass: () => controller,
        switchToHttp: () => ({
          getRequest: () => ({ user }),
        }),
      } as unknown as ExecutionContext,
      handler,
      controller,
    };
  };

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;
    guard = new RolesGuard(reflector);
  });

  it('allows any authenticated role when no role metadata is declared', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const { context, handler, controller } = contextFor(Role.CUSTOMER);

    expect(guard.canActivate(context)).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(ROLES_KEY, [handler, controller]);
  });

  it('allows a user whose role is among the required roles', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN, Role.SELLER]);

    expect(guard.canActivate(contextFor(Role.SELLER).context)).toBe(true);
  });

  it('rejects an authenticated user whose role is not permitted', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN, Role.SELLER]);

    expect(() => guard.canActivate(contextFor(Role.CUSTOMER).context)).toThrow(ForbiddenException);
  });

  it('rejects a missing user when role metadata is required', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);

    expect(() => guard.canActivate(contextFor().context)).toThrow(ForbiddenException);
  });
});
