/**
 * DDP-#38 / SDS §5.4 — the daily billing job must bill 200 due
 * subscriptions in under 60 seconds.
 *
 * Load fixtures/due-subscriptions.sql first, then this triggers one run
 * through POST /api/admin/subscriptions/billing/run (admin only, not
 * available in production builds). It is the same code path as the
 * 06:00 UTC job and returns its counts and duration.
 *
 *   k6 run load-test/k6/subscription-cron.js
 */
import http from 'k6/http';
import { check, fail } from 'k6';
import { Trend } from 'k6/metrics';
import { API_BASE, signIn } from './lib.js';

const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || 'loadtest-admin@example.com';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'Password123!';
const EXPECTED = Number(__ENV.EXPECTED_DUE || 200);

export const options = {
  scenarios: {
    one_run: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '5m' },
  },
  thresholds: {
    billing_run_ms: ['max<60000'],
    checks: ['rate==1'],
  },
};

const runDuration = new Trend('billing_run_ms', true);

export default function () {
  const session = signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  const res = http.post(`${API_BASE}/api/admin/subscriptions/billing/run`, null, {
    ...session,
    timeout: '120s',
  });
  if (res.status !== 200) fail(`billing run returned ${res.status}: ${res.body}`);

  const body = res.json();
  runDuration.add(body.durationMs);
  console.log(`billing run: ${JSON.stringify(body)}`);

  check(body, {
    'every due subscription found': (b) => b.due >= EXPECTED,
    'every due subscription renewed': (b) => b.renewed >= EXPECTED && b.errored === 0,
    'finished in under 60 s': (b) => b.durationMs < 60000,
  });
}
