import type { Role } from '@prisma/client';

/**
 * Distinguishes which Prisma table holds the row referenced by JWT `sub`.
 * The four actor tables (Customer / AdminUser / Seller / DeliveryUser) are
 * intentionally separate (SDS §7.2) — `actorType` is the discriminator.
 */
export type ActorType = 'customer' | 'admin' | 'seller' | 'delivery';

/** Decoded JWT payload. */
export interface JwtPayload {
  sub: string;
  role: Role;
  actorType: ActorType;
  jti: string;
  iat?: number;
  exp?: number;
}

/** Resolved user attached to `req.user` after JwtAuthGuard succeeds. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  actorType: ActorType;
  jti: string;
  expiresAt: number;
}
