import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { RedisService } from '../../redis/redis.service';
import type { AuthenticatedUser, JwtPayload } from '../types/auth.types';

export const AUTH_COOKIE_NAME = 'auth_token';

/**
 * JWT extraction order (SDS §5.1):
 *   1. HTTP-only `auth_token` cookie (browser clients)
 *   2. `Authorization: ****** (mobile/Flutter app, SDS §2.1.1)
 * After signature verification we additionally check the JTI revocation list
 * in Redis (SDS §7.1 — token blocklist on logout / forced revocation).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret || secret.length < 32) {
      throw new Error('JWT_SECRET must be set and at least 32 characters');
    }
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request): string | null => req?.cookies?.[AUTH_COOKIE_NAME] ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
      algorithms: ['HS256'],
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload?.jti || !payload.sub || !payload.role || !payload.actorType) {
      throw new UnauthorizedException('Malformed token');
    }
    const revoked = await this.redis.isJtiRevoked(payload.jti);
    if (revoked) {
      throw new UnauthorizedException('Token revoked');
    }
    return {
      id: payload.sub,
      email: '',
      role: payload.role,
      actorType: payload.actorType,
      jti: payload.jti,
      expiresAt: payload.exp ?? 0,
    };
  }
}
