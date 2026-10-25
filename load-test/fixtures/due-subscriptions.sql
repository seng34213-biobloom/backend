-- DDP-#38 — fixture for the k6 load tests.
--
-- Creates an admin (loadtest-admin@example.com), 200 customers
-- (loadtest-001@example.com to loadtest-200@example.com), each with one
-- address and one Subscribe & Save subscription due today, and a load-test
-- product with four variants holding 20,000 units each, enough for a full
-- checkout run, so stock never limits the measurement. Every account's password is Password123!.
--
-- Re-running replaces the previous fixture. Pass the API's
-- SUBSCRIPTION_TOKEN_ENC_KEY as enc_key so the job can decrypt the tokens:
--
--   docker compose exec -T postgres psql -U biobloom -d biobloom \
--     -v enc_key="$SUBSCRIPTION_TOKEN_ENC_KEY" < load-test/fixtures/due-subscriptions.sql

\set ON_ERROR_STOP on
BEGIN;

DELETE FROM payment WHERE subscription_id IN (
  SELECT s.id FROM subscription s JOIN customer c ON c.id = s.customer_id
  WHERE c.email LIKE 'loadtest-%@example.com');
DELETE FROM payment WHERE order_id IN (
  SELECT o.id FROM "order" o JOIN customer c ON c.id = o.customer_id
  WHERE c.email LIKE 'loadtest-%@example.com');
DELETE FROM "order" WHERE customer_id IN (
  SELECT id FROM customer WHERE email LIKE 'loadtest-%@example.com');
DELETE FROM cart_item WHERE customer_id IN (
  SELECT id FROM customer WHERE email LIKE 'loadtest-%@example.com');
DELETE FROM subscription WHERE customer_id IN (
  SELECT id FROM customer WHERE email LIKE 'loadtest-%@example.com');
DELETE FROM address WHERE customer_id IN (
  SELECT id FROM customer WHERE email LIKE 'loadtest-%@example.com');
DELETE FROM customer WHERE email LIKE 'loadtest-%@example.com';
DELETE FROM admin_user WHERE email = 'loadtest-admin@example.com';
DELETE FROM product WHERE slug = 'loadtest-kithul-jaggery';

-- bcrypt hash of Password123!
\set password_hash '$2a$10$RnE7f3LpDvlhDiOL7bOtWeLdBGtz/KIP6aRrUFqQXpxmWi6n6nRRa'

INSERT INTO admin_user (id, email, password_hash, name, role, updated_at)
VALUES (gen_random_uuid(), 'loadtest-admin@example.com', :'password_hash', 'Load Test Admin',
  'ADMIN', now());

INSERT INTO product (id, name, slug, description, base_price, unit_weight_grams, category,
  updated_at)
VALUES (gen_random_uuid(), 'Load Test Kithul Jaggery', 'loadtest-kithul-jaggery',
  'Load test fixture', 1000.00, 300, 'sweeteners', now());

CREATE TEMP TABLE lt_variant AS
SELECT gen_random_uuid() AS id, i - 1 AS n
FROM generate_series(1, 4) AS i;

INSERT INTO product_variant (id, product_id, sku, name, size, price, unit_weight_grams,
  updated_at)
SELECT v.id, p.id, format('LOADTEST-%s', v.n), format('300g pack %s', v.n + 1), '300 g',
  1000.00, 300, now()
FROM lt_variant v CROSS JOIN product p WHERE p.slug = 'loadtest-kithul-jaggery';

INSERT INTO product_batch (id, product_variant_id, batch_number, manufactured_date,
  expiry_date, initial_quantity, current_quantity, updated_at)
SELECT gen_random_uuid(), id, 'LOADTEST', CURRENT_DATE - 1, CURRENT_DATE + 365, 20000, 20000, now()
FROM lt_variant;

INSERT INTO customer (id, email, password_hash, name, updated_at)
SELECT gen_random_uuid(), format('loadtest-%s@example.com', lpad(i::text, 3, '0')),
  :'password_hash', format('Load Test %s', i), now()
FROM generate_series(1, 200) AS i;

INSERT INTO address (id, customer_id, line1, city, district, postal_code, is_default,
  updated_at)
SELECT gen_random_uuid(), c.id, '1 Test Lane', 'Colombo', 'Colombo', '00100', true, now()
FROM customer c WHERE c.email LIKE 'loadtest-%@example.com';

-- Test-mode tokens: the API approves any token without "fail" or "decline"
INSERT INTO subscription (id, customer_id, product_variant_id, shipping_address_id,
  frequency_days, discount_rate, quantity, status, next_billing_date,
  payment_token_encrypted, payment_gateway, updated_at)
SELECT gen_random_uuid(), c.id, v.id, a.id, 30, 0.1000, 1, 'ACTIVE', CURRENT_DATE,
  pgp_sym_encrypt(format('cus_loadtest:pm_%s', c.id), :'enc_key'), 'STRIPE', now()
FROM customer c
JOIN address a ON a.customer_id = c.id
JOIN lt_variant v ON v.n = (substring(c.email FROM 'loadtest-(\d+)')::int - 1) % 4
WHERE c.email LIKE 'loadtest-%@example.com';

COMMIT;

SELECT count(*) AS due_subscriptions FROM subscription s
JOIN customer c ON c.id = s.customer_id
WHERE c.email LIKE 'loadtest-%@example.com' AND s.status = 'ACTIVE'
  AND s.next_billing_date <= CURRENT_DATE;
