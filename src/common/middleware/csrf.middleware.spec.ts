import { ForbiddenException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CsrfMiddleware } from './csrf.middleware';

describe('CsrfMiddleware', () => {
  let middleware: CsrfMiddleware;
  let response: Response;
  let next: NextFunction;

  const requestFor = (
    method: string,
    url: string,
    cookies: Record<string, string> = {},
    headerToken?: string,
  ) =>
    ({
      method,
      originalUrl: url,
      url,
      path: url,
      cookies,
      header: jest.fn((name: string) =>
        name.toLowerCase() === CSRF_HEADER_NAME ? headerToken : undefined,
      ),
    }) as unknown as Request;

  beforeEach(() => {
    middleware = new CsrfMiddleware();
    response = { cookie: jest.fn() } as unknown as Response;
    next = jest.fn();
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('allows %s and issues a CSRF cookie', (method) => {
    const req = requestFor(method, '/api/private');

    middleware.use(req, response, next);

    expect(response.cookie).toHaveBeenCalledWith(
      CSRF_COOKIE_NAME,
      expect.stringMatching(/^[a-f0-9]{48}$/),
      expect.objectContaining({ httpOnly: false, sameSite: 'strict' }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a state-changing request when the cookie and header match', () => {
    const token = 'csrf-token-value';
    const req = requestFor('POST', '/api/private', { [CSRF_COOKIE_NAME]: token }, token);

    middleware.use(req, response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a state-changing request when the cookie and header differ', () => {
    const req = requestFor(
      'POST',
      '/api/private',
      { [CSRF_COOKIE_NAME]: 'cookie-token' },
      'header-token',
    );

    expect(() => middleware.use(req, response, next)).toThrow(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });

  it('exempts webhook requests from the double-submit check', () => {
    const req = requestFor('POST', '/api/webhooks/payment');

    middleware.use(req, response, next);

    expect(response.cookie).toHaveBeenCalledWith(
      CSRF_COOKIE_NAME,
      expect.stringMatching(/^[a-f0-9]{48}$/),
      expect.any(Object),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
