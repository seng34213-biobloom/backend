import { cookieSecurity } from './cookie-security';

describe('cookieSecurity', () => {
  const savedEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
  });

  it('uses SameSite=None with Secure in production', () => {
    process.env.NODE_ENV = 'production';

    expect(cookieSecurity()).toEqual({ secure: true, sameSite: 'none' });
  });

  it.each(['development', 'test'])('keeps SameSite=Strict without Secure in %s', (env) => {
    process.env.NODE_ENV = env;

    expect(cookieSecurity()).toEqual({ secure: false, sameSite: 'strict' });
  });
});
