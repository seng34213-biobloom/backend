import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedUser } from '../types/auth.types';

/**
 * Method-level role check (SDS §7.2). Apply with `@UseGuards(JwtAuthGuard,
 * RolesGuard)` then `@Roles(Role.ADMIN, …)`. Empty/missing decorator means
 * "any authenticated role allowed".
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const user = ctx.switchToHttp().getRequest().user as AuthenticatedUser | undefined;
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }
    if (!required.includes(user.role)) {
      throw new ForbiddenException(`Role ${user.role} not permitted`);
    }
    return true;
  }
}
