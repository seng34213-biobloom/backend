import { validateEnvironment } from './env.validation';

describe('validateEnvironment', () => {
  const productionSecrets = {
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(40),
    STRIPE_SECRET_KEY: 'sk_live_' + 'b'.repeat(32),
    STRIPE_WEBHOOK_SECRET: 'whsec_' + 'b'.repeat(32),
    SUBSCRIPTION_TOKEN_ENC_KEY: 'c'.repeat(24),
    AWS_REGION: 'us-east-1',
    UPLOADS_BUCKET: 'private-proof-images',
  };

  it('accepts strong production secrets', () => {
    expect(validateEnvironment(productionSecrets)).toBe(productionSecrets);
  });

  it('does not require production-only secret policy in development', () => {
    const config = { NODE_ENV: 'development', JWT_SECRET: 'change-me' };
    expect(validateEnvironment(config)).toBe(config);
  });

  it('names all missing production secrets', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow(
      /STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUBSCRIPTION_TOKEN_ENC_KEY/,
    );
  });

  it.each([
    ['JWT_SECRET', 'short'],
    ['JWT_SECRET', 'change-me-to-a-long-development-secret'],
    ['STRIPE_SECRET_KEY', 'sk_test_' + 'a'.repeat(32)],
    ['STRIPE_WEBHOOK_SECRET', 'whsec_replace_me'],
    ['SUBSCRIPTION_TOKEN_ENC_KEY', 'dev-subscription-key-change-me'],
  ])('rejects weak or development value for %s', (name, value) => {
    expect(() => validateEnvironment({ ...productionSecrets, [name]: value })).toThrow(
      new RegExp(name),
    );
  });

  it('requires a strong PayHere secret when PayHere is configured', () => {
    expect(() =>
      validateEnvironment({
        ...productionSecrets,
        PAYHERE_MERCHANT_ID: 'merchant-1',
        PAYHERE_MERCHANT_SECRET: 'replace_me',
      }),
    ).toThrow(/PAYHERE_MERCHANT_SECRET/);
  });

  it('requires an AWS region and private uploads bucket in production', () => {
    expect(() =>
      validateEnvironment({
        ...productionSecrets,
        AWS_REGION: '',
      }),
    ).toThrow(/AWS_REGION/);
    expect(() =>
      validateEnvironment({
        ...productionSecrets,
        UPLOADS_BUCKET: '',
      }),
    ).toThrow(/UPLOADS_BUCKET/);
  });
});
