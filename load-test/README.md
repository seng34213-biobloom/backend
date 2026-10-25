# Load tests (k6)

Backs the performance budget in SDS §2.3 and §5.4 (DDP-#38).

| Requirement                                             | Script                    | Threshold                  |
| ------------------------------------------------------- | ------------------------- | -------------------------- |
| Billing job handles 200 due subscriptions in under 60 s | `k6/subscription-cron.js` | `billing_run_ms max<60000` |

k6 exits non-zero and names the threshold when one is crossed, so a script can gate a pipeline step as it is. The scripts sign in through the real CSRF and login flow (`k6/lib.js`).

## Running against a local stack

Start PostgreSQL, Redis and MailHog, apply the migrations, then run the API with `NODE_ENV=test` so no real payment gateway is called (test mode approves every stored token without `fail` or `decline`, and fakes payment intents):

```sh
docker compose up -d
npm run prisma:deploy
npm run build
NODE_ENV=test npm run start:prod
```

Load the fixture: an admin (`loadtest-admin@example.com`), 200 customers (`loadtest-001@example.com` to `loadtest-200@example.com`), each with one address and one subscription due today, and a load-test product with four variants of 500 units each. Every password is `Password123!`. Pass the API's `SUBSCRIPTION_TOKEN_ENC_KEY` so the job can decrypt the tokens. Re-running replaces the previous fixture.

```sh
docker compose exec -T postgres psql -U biobloom -d biobloom \
  -v enc_key="$SUBSCRIPTION_TOKEN_ENC_KEY" < load-test/fixtures/due-subscriptions.sql
```

Then trigger one billing run:

```sh
k6 run load-test/k6/subscription-cron.js
```

The script calls `POST /api/admin/subscriptions/billing/run`, the same code path as the 06:00 UTC job, which is not available in production builds, staging included. A passing run ends with:

```
✓ 'max<60000' max=858ms
✓ every due subscription renewed
```

Reload the fixture before running it again, because the run moves every billing date on.
