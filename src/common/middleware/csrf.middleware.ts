import { ForbiddenException, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CSRF_COOKIE_NAME = 'csrf-token';
export const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Double-submit cookie CSRF (SDS §7.4).
 *
 * Idempotent verbs (GET/HEAD/OPTIONS) are exempt and used to issue the
 * token cookie. State-mutating verbs require the `X-CSRF-Token` header
 * to match the `csrf-token` cookie value byte-for-byte. The cookie is
 * SameSite=Strict so cross-site requests cannot read it; without read
 * access an attacker cannot forge the matching header.
 *
 * `/api/webhooks/*` is exempt — those are server-to-server with HMAC
 * signature verification (Phase 5) rather than browser cookies.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CsrfMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    const safeVerb = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);

    // Always make sure a token exists in the cookie jar so the SPA can read
    // it on the very first request.
    if (!req.cookies?.[CSRF_COOKIE_NAME]) {
      const token = randomBytes(24).toString('hex');
      res.cookie(CSRF_COOKIE_NAME, token, {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
      });
      // Propagate to the current request so safe-verb handlers see it.
      if (!req.cookies) req.cookies = {};
      req.cookies[CSRF_COOKIE_NAME] = token;
    }

    if (safeVerb) {
      return next();
    }

    // Webhook exemption — verified by HMAC, not by browser cookie.
    const url = req.originalUrl ?? req.url ?? req.path ?? '';
    if (url.startsWith('/api/webhooks/') || url.startsWith('/webhooks/')) {
      return next();
    }

    const cookie = req.cookies?.[CSRF_COOKIE_NAME];
    const header = req.header(CSRF_HEADER_NAME);
    if (!cookie || !header || cookie !== header) {
      this.logger.warn(`CSRF rejected ${req.method} ${req.path}`);
      throw new ForbiddenException('CSRF token missing or mismatched');
    }
    next();
  }
}
