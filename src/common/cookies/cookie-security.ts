import type { CookieOptions } from 'express';

/**
 * `secure` and `sameSite` for the auth and CSRF cookies.
 *
 * In production the API runs on its own domain, so a browser app served from
 * another site (the Flutter web build) only gets the cookies back when they are
 * SameSite=None, and browsers accept None only with Secure. The double-submit
 * CSRF check still guards every state-changing request. Locally the apps and
 * the API share the localhost site, so Strict keeps working there.
 */
export function cookieSecurity(): Pick<CookieOptions, 'secure' | 'sameSite'> {
  return process.env.NODE_ENV === 'production'
    ? { secure: true, sameSite: 'none' }
    : { secure: false, sameSite: 'strict' };
}
