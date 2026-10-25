const DEVELOPMENT_SECRET_MARKERS = [
  'change-me',
  'replace-me',
  'replace_me',
  'dev-',
  'development',
  'ci-only',
  'example',
  'your-',
];

const PRODUCTION_SECRETS: Record<string, number> = {
  JWT_SECRET: 32,
  STRIPE_SECRET_KEY: 24,
  STRIPE_WEBHOOK_SECRET: 16,
  SUBSCRIPTION_TOKEN_ENC_KEY: 16,
};

export function validateEnvironment<T extends Record<string, unknown>>(config: T): T {
  if (config.NODE_ENV !== 'production') return config;

  const missing: string[] = [];
  const insecure: string[] = [];
  const missingConfig: string[] = [];
  for (const [name, minimumLength] of Object.entries(PRODUCTION_SECRETS)) {
    const value = config[name];
    if (typeof value !== 'string' || value.length === 0) {
      missing.push(name);
      continue;
    }
    if (
      value.length < minimumLength ||
      (name === 'STRIPE_SECRET_KEY' && value.startsWith('sk_test_')) ||
      DEVELOPMENT_SECRET_MARKERS.some((marker) => value.toLowerCase().includes(marker))
    ) {
      insecure.push(name);
    }
  }

  for (const name of ['AWS_REGION', 'UPLOADS_BUCKET']) {
    const value = config[name];
    if (typeof value !== 'string' || value.trim().length === 0) missingConfig.push(name);
  }

  if (typeof config.PAYHERE_MERCHANT_ID === 'string' && config.PAYHERE_MERCHANT_ID.length > 0) {
    const value = config.PAYHERE_MERCHANT_SECRET;
    if (typeof value !== 'string' || value.length === 0) missing.push('PAYHERE_MERCHANT_SECRET');
    else if (
      value.length < 16 ||
      DEVELOPMENT_SECRET_MARKERS.some((marker) => value.toLowerCase().includes(marker))
    ) {
      insecure.push('PAYHERE_MERCHANT_SECRET');
    }
  }

  if (missing.length > 0 || insecure.length > 0 || missingConfig.length > 0) {
    const details = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
      insecure.length > 0 ? `development or weak values: ${insecure.join(', ')}` : '',
      missingConfig.length > 0 ? `missing: ${missingConfig.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(`Invalid production environment secrets (${details})`);
  }

  return config;
}
