import { SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';

/**
 * Restrict a route to one or more roles (SDS §7.2). Stack with JwtAuthGuard
 * + RolesGuard. Example: `@Roles(Role.ADMIN, Role.FULFILMENT_STAFF)`.
 */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
