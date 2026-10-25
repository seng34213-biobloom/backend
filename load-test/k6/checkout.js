/**
 * DDP-#38 / SDS §2.3 — checkout under load.
 *
 * Ramps to 50 concurrent shoppers for two minutes. Thresholds: p95 of the
 * checkout request under 600 ms and fewer than 1% failed requests. Each
 * virtual user signs in as its own customer (loadtest-001 to loadtest-200
 * from fixtures/due-subscriptions.sql), so carts never collide and the FIFO
 * row locks are what is measured.
 *
 * Raise the API's rate limits for a run from one machine:
 * THROTTLE_AUTH_LIMIT=1000 THROTTLE_DEFAULT_LIMIT=100000.
 *
 *   k6 run load-test/k6/checkout.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { API_BASE, signIn } from './lib.js';

const PASSWORD = __ENV.CUSTOMER_PASSWORD || 'Password123!';

export const options = {
  // Keep each virtual user signed in across iterations; k6 clears cookies by default
  noCookiesReset: true,
  scenarios: {
    shoppers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 25 },
        { duration: '2m', target: 50 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    'http_req_duration{stage:checkout}': ['p(95)<600'],
    http_req_failed: ['rate<0.01'],
  },
};

// One session, address and variant list per virtual user, set on its first iteration
let session = null;
let addressId = null;
let variants = [];

function setUpVu() {
  const n = String(((__VU - 1) % 200) + 1).padStart(3, '0');
  session = signIn(`loadtest-${n}@example.com`, PASSWORD);

  const addresses = http.get(`${API_BASE}/api/addresses`, { ...session, tags: { stage: 'setup' } });
  const list = addresses.json() || [];
  addressId = list.length > 0 ? list[0].id : null;

  const products = http.get(`${API_BASE}/api/products?search=Load%20Test&pageSize=24`, {
    tags: { stage: 'setup' },
  });
  const items = products.json('items') || [];
  variants = items.flatMap((p) => (p.variants || []).map((v) => v.id));
}

export default function () {
  if (!session) setUpVu();
  if (!addressId || variants.length === 0) {
    sleep(1);
    return;
  }

  const variantId = variants[Math.floor(Math.random() * variants.length)];
  const add = http.post(
    `${API_BASE}/api/cart/items`,
    JSON.stringify({ productVariantId: variantId, quantity: 1 }),
    { ...session, tags: { stage: 'cart' } },
  );
  check(add, { 'added to cart': (r) => r.status === 200 || r.status === 201 });

  const quote = http.get(`${API_BASE}/api/checkout/quote`, {
    ...session,
    tags: { stage: 'quote' },
  });
  check(quote, { 'quote 200': (r) => r.status === 200 });

  const checkout = http.post(
    `${API_BASE}/api/checkout`,
    JSON.stringify({ shippingAddressId: addressId }),
    { ...session, tags: { stage: 'checkout' } },
  );
  check(checkout, { 'order placed': (r) => r.status === 201 });

  sleep(0.5);
}
