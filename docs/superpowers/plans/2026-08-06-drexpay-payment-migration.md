# DrexPay Payment Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Stripe/PayPal/NowPayments with DrexPay as the sole wallet top-up gateway, and
make NGN the wallet's real backend unit (it's currently USD with a frontend Naira display mask).

**Architecture:** DrexPay follows the exact `transactions`-row-pending→webhook-credits shape the
three removed gateways already used (see `docs/superpowers/specs/2026-08-06-drexpay-payment-migration-design.md`).
The currency migration flips the unit `profiles.wallet_balance`/`transactions.amount`/
`orders.user_cost` are interpreted in, rescaling existing balances so real value is preserved,
and removes the frontend's USD→NGN display conversion since the backend now speaks NGN natively.

**Tech Stack:** Node.js/Express, axios (already a dependency), Supabase/Postgres, Jest, plain
HTML/JS frontend (no build step).

## Global Constraints

- Never block or fail a purchase/top-up over a notification or non-critical side effect —
  matches the existing fire-and-forget email pattern.
- No new npm dependency for DrexPay — use `axios`, already a dependency.
- Bonuses are disabled entirely, per explicit user decision — `calculateBonus` always returns
  `0`; do not add bonus tiers, bonus UI, or bonus copy anywhere touched by this plan.
- `profiles.wallet_balance` rescaling (×1600) and the NGN-aware backend code must ship together
  — this is a deployment-sequencing note for whoever ships this, not a task-ordering constraint
  within this plan (dev/test execution order below is chosen for buildability, not deploy order).
- Match existing code style: `jest.mock('../utils/logger', ...)` once at the top of test files,
  no `jest.resetModules()`/`jest.doMock()` (see `tests/errorHandler.test.js` and
  `tests/telegramService.test.js` — a prior attempt at using `resetModules`/`doMock` in this
  codebase caused every assertion to silently check stale mock instances).

---

### Task 1: NGN currency foundations — config, provider pricing, DB migration

**Files:**
- Modify: `config/env.js` (add `drexpay` block before the `stripe` block at line 73; add
  `ngnRate` after `priceMarkup` at line 91)
- Modify: `services/smsProvider.js:294-295` (`calculateUserPrice`)
- Create: `tests/smsProvider.test.js`
- Create: `supabase/migrations/0005_ngn_migration.sql`

**Interfaces:**
- Produces: `env.drexpay.secretKey`, `env.drexpay.webhookSecret`, `env.ngnRate` (number,
  defaults to `1600`) — consumed by Task 2's `drexpayService.js` and this task's
  `calculateUserPrice`.
- Consumes: `env.priceMarkup` (existing).

- [ ] **Step 1: Write the failing test**

Create `tests/smsProvider.test.js`:

```js
const { calculateUserPrice } = require('../services/smsProvider');

describe('calculateUserPrice', () => {
  test('applies the markup and NGN rate, rounded to whole naira', () => {
    // 10 * priceMarkup(1.4 default) * ngnRate(1600 default) = 22400
    expect(calculateUserPrice(10)).toBe(22400);
  });

  test('rounds to the nearest whole naira', () => {
    // 1 * 1.4 * 1600 = 2240 exactly; use a cost that doesn't land on a whole number pre-round
    expect(calculateUserPrice(0.333)).toBe(Math.round(0.333 * 1.4 * 1600));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/smsProvider.test.js`
Expected: FAIL — `calculateUserPrice(10)` currently returns `14` (USD, 2dp), not `22400`.

- [ ] **Step 3: Add the `drexpay` and `ngnRate` config entries**

In `config/env.js`, insert immediately before the `stripe:` block (currently line 73):

```js
  drexpay: {
    secretKey:     process.env.DREXPAY_SECRET_KEY,
    webhookSecret: process.env.DREXPAY_WEBHOOK_SECRET
  },

```

Insert immediately after `priceMarkup: parseFloat(process.env.PRICE_MARKUP) || 1.4,` (currently
line 91):

```js

  ngnRate: parseFloat(process.env.NGN_RATE) || 1600,
```

(Leave the existing `stripe`/`nowPayments`/`paypal` blocks in place for now — Task 5 removes
them once nothing references them.)

- [ ] **Step 4: Update `calculateUserPrice`**

In `services/smsProvider.js`, replace:

```js
const calculateUserPrice = (providerCost) =>
  Math.round((providerCost * env.priceMarkup) * 100) / 100;
```

with:

```js
const calculateUserPrice = (providerCost) =>
  Math.round(providerCost * env.priceMarkup * env.ngnRate);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest tests/smsProvider.test.js`
Expected: PASS — 2 tests

- [ ] **Step 6: Create the wallet-balance rescale migration**

Create `supabase/migrations/0005_ngn_migration.sql`:

```sql
-- Migrate the wallet/transaction/order currency model from USD to NGN.
-- profiles.wallet_balance is a single running total with no per-row
-- currency tag, so every existing balance must be rescaled now to
-- preserve real value (a $50 balance becomes ₦80,000 — same purchasing
-- power, new unit). This must ship in the same deploy as the NGN-aware
-- backend code — see docs/superpowers/specs/2026-08-06-drexpay-payment-migration-design.md.
update profiles set wallet_balance = wallet_balance * 1600;

-- transactions and orders keep their own per-row currency column —
-- historical rows correctly stay 'USD' (an accurate record of what
-- actually happened); only the default for newly-inserted rows changes.
alter table transactions alter column currency set default 'NGN';
alter table orders alter column currency set default 'NGN';
```

This is not run automatically by the test suite (it needs a real Postgres/Supabase target).
Apply it with `npm run db:migrate` against your dev database when ready, and again against
production in the same deploy window as the code from this plan.

- [ ] **Step 7: Commit**

```bash
git add config/env.js services/smsProvider.js tests/smsProvider.test.js supabase/migrations/0005_ngn_migration.sql
git commit -m "$(cat <<'EOF'
Add NGN currency config and fold conversion into calculateUserPrice

Provider costs now convert straight to NGN (markup × ngnRate) instead
of staying USD-labeled. Wallet-balance rescale migration included but
not auto-applied — see migration file header for deploy timing.
EOF
)"
```

---

### Task 2: `services/drexpayService.js` — payment-link creation and webhook signing

**Files:**
- Create: `services/drexpayService.js`
- Test: `tests/drexpayService.test.js`

**Interfaces:**
- Produces: `createPaymentLink({ email, amount })` → `Promise<{ id, url, reference }>`, throws
  `ApiError.internal('DrexPay not configured')` if `env.drexpay.secretKey` is unset.
  `verifyWebhookSignature(rawBody, signature)` → `boolean`.
- Consumes: `env.drexpay.secretKey`, `env.drexpay.webhookSecret`, `env.frontendUrl` (Task 1).

- [ ] **Step 1: Write the failing test file**

Create `tests/drexpayService.test.js`:

```js
/**
 * drexpayService — payment-link creation and webhook signature
 * verification for the DrexPay gateway.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('axios');

const axios   = require('axios');
const crypto  = require('crypto');
const env     = require('../config/env');
const drexpay = require('../services/drexpayService');

describe('drexpayService.createPaymentLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    env.drexpay = { secretKey: 'ngp_sk_test_abc', webhookSecret: 'whsec_test' };
  });

  test('posts to /api/payment-links with the Bearer token and returns id/url/reference', async () => {
    axios.post.mockResolvedValue({
      data: { id: 'pl_1', url: 'https://pay.drexpay.tech/pl_1', reference: 'PAY-1A2B', amount: 5000, email: 'a@b.com' }
    });

    const result = await drexpay.createPaymentLink({ email: 'a@b.com', amount: 5000 });

    expect(axios.post).toHaveBeenCalledWith(
      'https://drexpay.tech/api/payment-links',
      expect.objectContaining({
        email: 'a@b.com',
        amount: 5000,
        redirectTo: expect.stringContaining('/dashboard?topup=success')
      }),
      expect.objectContaining({ headers: { Authorization: 'Bearer ngp_sk_test_abc' } })
    );
    expect(result).toEqual({ id: 'pl_1', url: 'https://pay.drexpay.tech/pl_1', reference: 'PAY-1A2B' });
  });

  test('rejects when DrexPay is not configured', async () => {
    env.drexpay = {};
    await expect(drexpay.createPaymentLink({ email: 'a@b.com', amount: 5000 }))
      .rejects.toMatchObject({ statusCode: 500 });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('drexpayService.verifyWebhookSignature', () => {
  beforeEach(() => {
    env.drexpay = { secretKey: 'ngp_sk_test_abc', webhookSecret: 'whsec_test' };
  });

  test('accepts a correctly computed HMAC-SHA512 signature', () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'PAY-1A2B' } });
    const sig = crypto.createHmac('sha512', 'whsec_test').update(Buffer.from(body)).digest('hex');
    expect(drexpay.verifyWebhookSignature(body, sig)).toBe(true);
  });

  test('rejects an incorrect signature', () => {
    expect(drexpay.verifyWebhookSignature('{}', 'deadbeef')).toBe(false);
  });

  test('rejects when no webhook secret is configured', () => {
    env.drexpay = { secretKey: 'x' };
    expect(drexpay.verifyWebhookSignature('{}', 'anything')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/drexpayService.test.js`
Expected: FAIL — `Cannot find module '../services/drexpayService'`

- [ ] **Step 3: Write the service implementation**

Create `services/drexpayService.js`:

```js
/**
 * DrexPay service — NGN payment links via bank transfer.
 * https://drexpay.tech/docs
 */
const axios    = require('axios');
const crypto   = require('crypto');
const env      = require('../config/env');
const ApiError = require('../utils/apiError');

const BASE_URL = 'https://drexpay.tech';

const createPaymentLink = async ({ email, amount }) => {
  if (!env.drexpay.secretKey) throw ApiError.internal('DrexPay not configured');
  const { data } = await axios.post(`${BASE_URL}/api/payment-links`, {
    email,
    amount: Math.round(amount),
    redirectTo: `${env.frontendUrl}/dashboard?topup=success`
  }, {
    headers: { Authorization: `Bearer ${env.drexpay.secretKey}` }
  });
  return { id: data.id, url: data.url, reference: data.reference };
};

// HMAC-SHA512 over the raw request body. DrexPay's docs confirm
// "HMAC-SHA512 verification" but don't fully spell out the exact payload
// convention — this follows the same raw-body approach Stripe's webhook
// signing uses in this codebase. CONFIRM against the DrexPay merchant
// dashboard's webhook docs before go-live (see Task 3's setup note); if
// it turns out to be a canonicalized/sorted-JSON scheme instead,
// nowPaymentsService.verifyIpnSignature (git history — removed by Task 5
// of this plan) is the template for that variant.
const verifyWebhookSignature = (rawBody, signature) => {
  if (!env.drexpay.webhookSecret || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const computed = crypto.createHmac('sha512', env.drexpay.webhookSecret).update(body).digest('hex');
  return computed === signature;
};

module.exports = { createPaymentLink, verifyWebhookSignature };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest tests/drexpayService.test.js`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add services/drexpayService.js tests/drexpayService.test.js
git commit -m "$(cat <<'EOF'
Add DrexPay service — payment links + webhook signature verification
EOF
)"
```

---

### Task 3: `webhooks/drexpayWebhook.js` — confirms top-ups, credits wallet

**Files:**
- Create: `webhooks/drexpayWebhook.js`
- Test: `tests/drexpayWebhook.test.js`

**Interfaces:**
- Consumes: `drexpayService.verifyWebhookSignature` (Task 2), `walletController.creditWallet`
  (existing — `{userId, amount, bonus, externalId, method, description}` → `Promise<{user, tx}>`),
  `emailService.sendTopupConfirmation` (existing).
- Produces: an Express handler `(req, res)` — mounted by Task 4 at
  `POST /api/payments/webhooks/drexpay` with `express.raw({ type: 'application/json' })`.

- [ ] **Step 1: Write the failing test file**

Create `tests/drexpayWebhook.test.js`:

```js
/**
 * drexpayWebhook — verifies signature, looks up the pending transaction
 * by DrexPay's reference, and credits the wallet from OUR stored amount
 * (DrexPay's webhook payload never includes one).
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/drexpayService');
jest.mock('../controllers/walletController');
jest.mock('../services/emailService', () => ({ sendTopupConfirmation: jest.fn().mockResolvedValue() }));
jest.mock('../config/supabase', () => ({ supabase: { from: jest.fn() } }));

const { supabase } = require('../config/supabase');
const drexpay = require('../services/drexpayService');
const wallet  = require('../controllers/walletController');
const email   = require('../services/emailService');
const handler = require('../webhooks/drexpayWebhook');

const mockRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

const pendingTxRow = {
  id: 'tx1', user_id: 'u1', amount: 5000, bonus_amount: 0,
  status: 'pending', external_id: 'PAY-1A2B', metadata: null
};

const mockFindPending = (row) => {
  supabase.from.mockImplementation((table) => {
    if (table !== 'transactions') throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
      update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) })
    };
  });
};

describe('drexpayWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    drexpay.verifyWebhookSignature.mockReturnValue(true);
  });

  test('invalid signature → 400, no wallet mutation', async () => {
    drexpay.verifyWebhookSignature.mockReturnValue(false);
    const req = { headers: {}, body: Buffer.from('{}') };
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(wallet.creditWallet).not.toHaveBeenCalled();
  });

  test('charge.success with no matching pending transaction → 200, no credit', async () => {
    mockFindPending(null);
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'UNKNOWN' } }));
    const req = { headers: {}, body };
    const res = mockRes();

    await handler(req, res);

    expect(wallet.creditWallet).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  test('charge.success credits the pending transaction and emails confirmation', async () => {
    mockFindPending(pendingTxRow);
    wallet.creditWallet.mockResolvedValue({
      user: { id: 'u1', walletBalance: 5000, email: 'a@b.com' },
      tx: { id: 'newtx', amount: 5000, bonusAmount: 0, balanceAfter: 5000 }
    });
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'PAY-1A2B' } }));
    const req = { headers: {}, body };
    const res = mockRes();

    await handler(req, res);

    expect(wallet.creditWallet).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', amount: 5000, bonus: 0, externalId: 'PAY-1A2B', method: 'drexpay'
    }));
    expect(email.sendTopupConfirmation).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  test('charge.failed marks the transaction failed without crediting', async () => {
    mockFindPending(pendingTxRow);
    const body = Buffer.from(JSON.stringify({ event: 'charge.failed', data: { reference: 'PAY-1A2B' } }));
    const req = { headers: {}, body };
    const res = mockRes();

    await handler(req, res);

    expect(wallet.creditWallet).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/drexpayWebhook.test.js`
Expected: FAIL — `Cannot find module '../webhooks/drexpayWebhook'`

- [ ] **Step 3: Write the webhook handler**

Create `webhooks/drexpayWebhook.js`:

```js
/**
 * DrexPay webhook handler — confirms top-ups and credits wallet.
 * Endpoint must receive RAW body, not JSON-parsed (signature verification
 * needs the exact bytes DrexPay signed).
 */
const drexpay          = require('../services/drexpayService');
const { supabase }     = require('../config/supabase');
const wallet           = require('../controllers/walletController');
const email            = require('../services/emailService');
const logger           = require('../utils/logger');
const asyncHandler     = require('../utils/asyncHandler');
const { toCamelCase }  = require('../utils/caseMapper');

module.exports = asyncHandler(async (req, res) => {
  const signature = req.headers['x-drexpay-signature'];

  if (!drexpay.verifyWebhookSignature(req.body, signature)) {
    logger.warn('DrexPay webhook signature invalid');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body.toString('utf8'));
  const reference = event.data && event.data.reference;
  logger.info(`DrexPay webhook: ${event.event} → ${reference}`);

  if (!reference) return res.json({ received: true });

  const { data: pendingRow, error: findErr } = await supabase
    .from('transactions').select('*').eq('external_id', reference).eq('status', 'pending').maybeSingle();
  if (findErr) { logger.error('DrexPay webhook lookup failed:', findErr.message); return res.json({ received: true }); }
  if (!pendingRow) {
    logger.warn(`DrexPay webhook: no pending tx for reference ${reference}`);
    return res.json({ received: true });
  }
  const pending = toCamelCase(pendingRow);

  switch (event.event) {
    case 'charge.success': {
      const { user, tx } = await wallet.creditWallet({
        userId: pending.userId, amount: pending.amount, bonus: pending.bonusAmount || 0,
        externalId: reference, method: 'drexpay', description: `DrexPay top-up (₦${pending.amount})`
      });

      const { error } = await supabase.from('transactions').update({
        status: 'success', balance_after: user.walletBalance,
        metadata: { ...(pending.metadata || {}), drexpayReference: reference, fulfilledTxId: tx.id }
      }).eq('id', pending.id);
      if (error) logger.error('DrexPay webhook: failed to mark tx fulfilled:', error.message);

      email.sendTopupConfirmation(user, tx).catch(e => logger.error('Topup email:', e.message));
      break;
    }

    case 'charge.failed': {
      const { error } = await supabase.from('transactions').update({ status: 'failed' }).eq('id', pending.id);
      if (error) logger.error('DrexPay webhook: failed to mark tx failed:', error.message);
      break;
    }

    default:
      logger.debug(`Unhandled DrexPay event: ${event.event}`);
  }

  res.json({ received: true });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest tests/drexpayWebhook.test.js`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add webhooks/drexpayWebhook.js tests/drexpayWebhook.test.js
git commit -m "$(cat <<'EOF'
Add DrexPay webhook handler — credits wallet on charge.success
EOF
)"
```

---

### Task 4: Wire DrexPay into the wallet top-up flow and payment routes

**Files:**
- Modify: `controllers/walletController.js` (imports at top; `calculateBonus`; `getWallet`;
  `initiateTopup`)
- Modify: `routes/paymentRoutes.js` (full rewrite)
- Modify: `tests/wallet.test.js`

**Interfaces:**
- Consumes: `drexpayService.createPaymentLink` (Task 2), `webhooks/drexpayWebhook` (Task 3).
- Produces: `walletController.calculateBonus(amount)` → always `0` (was tiered). `getWallet`
  response `currency: 'NGN'` (was `'USD'`). `POST /api/wallet/topup` accepts `method: 'drexpay'`.

- [ ] **Step 1: Update `tests/wallet.test.js` for the new contract**

In `tests/wallet.test.js`, change every `method: 'stripe'` and `method: 'paypal'` fixture value
to `method: 'drexpay'` (mechanical substitution — same test bodies, just realistic method
names). Then add:

```js
describe('calculateBonus', () => {
  test('always returns 0 — bonuses are disabled', () => {
    expect(wallet.calculateBonus(10)).toBe(0);
    expect(wallet.calculateBonus(50000)).toBe(0);
    expect(wallet.calculateBonus(0)).toBe(0);
  });
});
```

(Add this near the top of the file, alongside the existing `describe` blocks — check the
existing `require('../controllers/walletController')` import name at the top of the file and
reuse it rather than re-importing.)

- [ ] **Step 2: Run the test to verify the new assertion fails**

Run: `npx jest tests/wallet.test.js`
Expected: FAIL — `calculateBonus(10)` currently returns `0` already for amounts under 25, but
`calculateBonus(50000)` currently returns `10000` (20% tier), not `0`.

- [ ] **Step 3: Update `walletController.js`**

Replace the imports block (currently):

```js
const stripe       = require('../services/stripeService');
const nowpay       = require('../services/nowPaymentsService');
const paypal       = require('../services/paypalService');
```

with:

```js
const drexpay      = require('../services/drexpayService');
```

Replace `calculateBonus`:

```js
const calculateBonus = (amount) => {
  if (amount >= 100) return amount * 0.20;
  if (amount >= 50)  return amount * 0.15;
  if (amount >= 25)  return amount * 0.10;
  return 0;
};
```

with:

```js
// Bonuses are disabled — kept as a function (not deleted) since `bonus`
// still flows through initiateTopup/creditWallet/transactions.bonus_amount
// and the email template's conditional bonus line; forcing the source to
// 0 makes all of that correctly inert without touching those call sites.
const calculateBonus = (_amount) => 0;
```

In `getWallet`, change:

```js
  res.json({ success: true, balance: req.user.walletBalance, currency: 'USD' });
```

to:

```js
  res.json({ success: true, balance: req.user.walletBalance, currency: 'NGN' });
```

In `initiateTopup`, change the destructure and validation:

```js
  const { amount, method, payCurrency } = req.body;
  const amt = parseFloat(amount);

  if (!amt || amt < 1) throw ApiError.badRequest('Minimum top-up is $1');
  if (amt > 10000)     throw ApiError.badRequest('Maximum top-up is $10,000');
```

to:

```js
  const { amount, method } = req.body;
  const amt = parseFloat(amount);

  if (!amt || amt < 1500)     throw ApiError.badRequest('Minimum top-up is ₦1,500');
  if (amt > 15000000)         throw ApiError.badRequest('Maximum top-up is ₦15,000,000');
```

Replace the entire `switch (method) { ... }` block (the `stripe`/`nowpayments`/`paypal`/
`default` cases) with:

```js
  switch (method) {
    case 'drexpay': {
      const link = await drexpay.createPaymentLink({ email: req.user.email, amount: amt });
      await supabase.from('transactions').update({ external_id: link.reference }).eq('id', txRow.id);
      paymentData = { url: link.url, reference: link.reference };
      break;
    }
    default:
      throw ApiError.badRequest('Invalid payment method');
  }
```

- [ ] **Step 4: Rewrite `routes/paymentRoutes.js`**

Replace the entire file with:

```js
/**
 * Payment routes — DrexPay webhook.
 */
const router  = require('express').Router();
const express = require('express');
const { webhookLimiter } = require('../middleware/rateLimiter');
const drexpayWebhook = require('../webhooks/drexpayWebhook');

router.post('/webhooks/drexpay',
  express.raw({ type: 'application/json' }),
  webhookLimiter,
  drexpayWebhook);

module.exports = router;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest tests/wallet.test.js`
Expected: PASS — all tests including the new `calculateBonus` describe block.

- [ ] **Step 6: Commit**

```bash
git add controllers/walletController.js routes/paymentRoutes.js tests/wallet.test.js
git commit -m "$(cat <<'EOF'
Wire DrexPay into wallet top-up flow, disable bonuses, rescale limits to NGN

initiateTopup now only accepts method: 'drexpay'. calculateBonus always
returns 0 per product decision. Top-up min/max moved from $1/$10,000 to
₦1,500/₦15,000,000.
EOF
)"
```

---

### Task 5: Remove Stripe/PayPal/NowPayments — files, dependencies, config, env template

**Files:**
- Delete: `services/stripeService.js`, `services/paypalService.js`, `services/nowPaymentsService.js`
- Delete: `webhooks/stripeWebhook.js`, `webhooks/nowPaymentsWebhook.js`, `webhooks/paypalWebhook.js`
- Modify: `package.json` (remove `stripe`, `@paypal/checkout-server-sdk`)
- Modify: `config/env.js` (remove `stripe`, `nowPayments`, `paypal` blocks)
- Modify: `.env.example` (remove `STRIPE_*`/`NOWPAYMENTS_*`/`PAYPAL_*`, add `DREXPAY_*`)

**Interfaces:** None — pure removal. Nothing produced by this task; it depends on Task 4 having
already removed every reference to the deleted services first (verified in Step 3 below).

- [ ] **Step 1: Verify nothing still references the files being deleted**

Run: `grep -rn "stripeService\|paypalService\|nowPaymentsService\|stripeWebhook\|paypalWebhook\|nowPaymentsWebhook" --include="*.js" controllers/ routes/ webhooks/ services/ server.js`

Expected: no output (Task 4 already removed the only call sites, in `walletController.js` and
`paymentRoutes.js`). If anything shows up, stop and resolve it before deleting — do not delete a
file something still imports.

- [ ] **Step 2: Delete the gateway service and webhook files**

```bash
git rm services/stripeService.js services/paypalService.js services/nowPaymentsService.js
git rm webhooks/stripeWebhook.js webhooks/nowPaymentsWebhook.js webhooks/paypalWebhook.js
```

- [ ] **Step 3: Remove the npm dependencies**

In `package.json`, delete these two lines from `dependencies`:

```json
    "@paypal/checkout-server-sdk": "^1.0.3",
```
```json
    "stripe": "^16.2.0",
```

Run: `npm install` (updates `package-lock.json` to match)

- [ ] **Step 4: Remove the old config blocks from `config/env.js`**

Delete the `stripe`, `nowPayments`, and `paypal` blocks (the ones immediately following the
`sms` block and preceding `priceMarkup`):

```js
  stripe: {
    secret:        process.env.STRIPE_SECRET_KEY,
    publishable:   process.env.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET
  },

  nowPayments: {
    apiKey:    process.env.NOWPAYMENTS_API_KEY,
    ipnSecret: process.env.NOWPAYMENTS_IPN_SECRET,
    baseUrl:   process.env.NOWPAYMENTS_BASE_URL || 'https://api.nowpayments.io/v1'
  },

  paypal: {
    clientId:     process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    mode:         process.env.PAYPAL_MODE || 'sandbox'
  },

```

(The `drexpay` block Task 1 added stays — it now sits where `stripe` used to be, directly
before `priceMarkup`.)

- [ ] **Step 5: Update `.env.example`**

Replace:

```
# ── STRIPE (Card payments) ──
# STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxx
# STRIPE_PUBLISHABLE_KEY=pk_test_xxxxxxxxxxxx
# STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx

# ── NOWPAYMENTS (Crypto: USDT/BTC/ETH) ──
# NOWPAYMENTS_API_KEY=your_nowpayments_key
# NOWPAYMENTS_IPN_SECRET=your_ipn_secret
# NOWPAYMENTS_BASE_URL=https://api.nowpayments.io/v1

# ── PAYPAL ──
# PAYPAL_CLIENT_ID=your_paypal_client_id
# PAYPAL_CLIENT_SECRET=your_paypal_client_secret
# PAYPAL_MODE=sandbox
```

with:

```
# ── DREXPAY (NGN bank transfer) — https://drexpay.tech/docs ──
# DREXPAY_SECRET_KEY=ngp_sk_test_xxxxxxxxxxxx
# DREXPAY_WEBHOOK_SECRET=your_drexpay_webhook_secret
# NGN_RATE=1600
```

- [ ] **Step 6: Run the full test suite**

Run: `npx jest`
Expected: PASS — all suites green with the old gateways completely gone.

- [ ] **Step 7: Commit**

```bash
git add -u services/ webhooks/ package.json package-lock.json config/env.js .env.example
git commit -m "$(cat <<'EOF'
Remove Stripe, PayPal, and NowPayments

Fully replaced by DrexPay (Tasks 1-4). Deletes the service modules,
webhook handlers, npm dependencies, config blocks, and .env.example
entries — nothing referenced them anymore after the wallet controller
and payment routes were rewired.
EOF
)"
```

---

### Task 6: Backend currency-symbol updates

**Files:**
- Modify: `services/emailService.js:79,89-91`
- Modify: `controllers/numberController.js:132,158`

**Interfaces:** None new — string content only, no signature changes.

- [ ] **Step 1: Update `emailService.js`**

Change (line 79):
```js
    <p style="color:#94A3B8;font-size:14px">Service: ${order.serviceType.toUpperCase()} · Country: ${order.country} · Cost: $${order.userCost.toFixed(2)}</p>
```
to:
```js
    <p style="color:#94A3B8;font-size:14px">Service: ${order.serviceType.toUpperCase()} · Country: ${order.country} · Cost: ₦${order.userCost.toFixed(2)}</p>
```

Change (lines 89-91):
```js
      <tr><td style="padding:10px;border-bottom:1px solid #1E1B4B;color:#64748B">Amount</td><td style="padding:10px;border-bottom:1px solid #1E1B4B;text-align:right;color:#34D399;font-weight:bold">+$${tx.amount.toFixed(2)}</td></tr>
      ${tx.bonusAmount > 0 ? `<tr><td style="padding:10px;border-bottom:1px solid #1E1B4B;color:#64748B">Bonus</td><td style="padding:10px;border-bottom:1px solid #1E1B4B;text-align:right;color:#34D399">+$${tx.bonusAmount.toFixed(2)}</td></tr>` : ''}
      <tr><td style="padding:10px;color:#64748B">New balance</td><td style="padding:10px;text-align:right;color:#A78BFA;font-weight:bold">$${tx.balanceAfter.toFixed(2)}</td></tr>
```
to:
```js
      <tr><td style="padding:10px;border-bottom:1px solid #1E1B4B;color:#64748B">Amount</td><td style="padding:10px;border-bottom:1px solid #1E1B4B;text-align:right;color:#34D399;font-weight:bold">+₦${tx.amount.toFixed(2)}</td></tr>
      ${tx.bonusAmount > 0 ? `<tr><td style="padding:10px;border-bottom:1px solid #1E1B4B;color:#64748B">Bonus</td><td style="padding:10px;border-bottom:1px solid #1E1B4B;text-align:right;color:#34D399">+₦${tx.bonusAmount.toFixed(2)}</td></tr>` : ''}
      <tr><td style="padding:10px;color:#64748B">New balance</td><td style="padding:10px;text-align:right;color:#A78BFA;font-weight:bold">₦${tx.balanceAfter.toFixed(2)}</td></tr>
```

(The bonus line's condition is always false now since `calculateBonus` returns `0` — left in
place rather than deleted, matching Task 4's "force the source to 0, don't touch downstream
call sites" approach.)

- [ ] **Step 2: Update `numberController.js`**

Change (line 132):
```js
    currency: 'USD', providerCurrency: currency, available: count, provider: provider.name
```
to:
```js
    currency: 'NGN', providerCurrency: currency, available: count, provider: provider.name
```
(`providerCurrency` is the upstream SMS provider's raw currency — RUB/USD — and stays
unchanged; only `currency`, describing `userPrice`, changes.)

Change (lines 157-159):
```js
    throw ApiError.badRequest(
      `Insufficient balance. Need $${userCost.toFixed(2)}, have $${req.user.walletBalance.toFixed(2)}`
    );
```
to:
```js
    throw ApiError.badRequest(
      `Insufficient balance. Need ₦${userCost.toFixed(2)}, have ₦${req.user.walletBalance.toFixed(2)}`
    );
```

- [ ] **Step 3: Run the full backend test suite**

Run: `npx jest`
Expected: PASS — no test asserts on these exact strings today, so this is a behavior-preserving
formatting change; confirms nothing broke.

- [ ] **Step 4: Commit**

```bash
git add services/emailService.js controllers/numberController.js
git commit -m "$(cat <<'EOF'
Show ₦ instead of $ in emails and API error messages
EOF
)"
```

---

### Task 7: Frontend — currency formatting and top-up flow (`public/app.js`)

**Files:**
- Modify: `public/app.js:18-41` (currency helpers)
- Modify: `public/app.js` (`selectTopup`, `onCustomAmountInput`, `updateTopupSummary`,
  `processTopup`; delete `selectPayMethod`)
- Modify: `public/app.js:1300,2375,2457` (`fmtNGN` call sites → `fmtNaira`)

**Interfaces:**
- Produces: `fmtNaira(ngn, dp=0)` now formats a Naira value directly (no conversion) — same
  name, same call signature, every existing call site (order costs, wallet balances, admin
  tables) keeps working unmodified. `fmtNGN` and `nairaToUsd` are removed.

- [ ] **Step 1: Replace the currency-helpers block**

Replace lines 18-41 of `public/app.js`:

```js
// ── CURRENCY (Naira) ───────────────────────────────────────
// All backend amounts are stored in USD; the UI shows Naira.
// Change NGN_RATE here to update the exchange rate everywhere.
const NGN_RATE = 1600;

// Format a USD amount as Naira, e.g. fmtNaira(24.5) -> "₦39,200".
function fmtNaira(usd, dp = 0) {
  const n = (parseFloat(usd) || 0) * NGN_RATE;
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
// Signed variant for transactions: +₦.. / -₦..
function fmtNairaSigned(usd, dp = 0) {
  const v = parseFloat(usd) || 0;
  return (v >= 0 ? '+' : '-') + fmtNaira(Math.abs(v), dp);
}
// Format a value that's ALREADY in Naira (no exchange-rate conversion).
// Used for admin-managed Product prices, which are entered directly in
// Naira — unlike fmtNaira(), which converts from USD.
function fmtNGN(ngn, dp = 0) {
  const n = parseFloat(ngn) || 0;
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
// Convert a Naira amount entered by the user back into USD for the API.
function nairaToUsd(naira) { return (parseFloat(naira) || 0) / NGN_RATE; }
```

with:

```js
// ── CURRENCY (Naira) ───────────────────────────────────────
// The backend stores and returns amounts in NGN directly — no conversion.
function fmtNaira(ngn, dp = 0) {
  const n = parseFloat(ngn) || 0;
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
// Signed variant for transactions: +₦.. / -₦..
function fmtNairaSigned(ngn, dp = 0) {
  const v = parseFloat(ngn) || 0;
  return (v >= 0 ? '+' : '-') + fmtNaira(Math.abs(v), dp);
}
```

- [ ] **Step 2: Replace the three now-removed `fmtNGN(...)` call sites with `fmtNaira(...)`**

Line 1300: `<div class="prod-price">${fmtNGN(p.price)}</div>` → `<div class="prod-price">${fmtNaira(p.price)}</div>`

Line 2375: `<td>${fmtNGN(p.price)}</td>` → `<td>${fmtNaira(p.price)}</td>`

Line 2457: `if (el) el.textContent = fmtNGN(ngn);` → `if (el) el.textContent = fmtNaira(ngn);`

- [ ] **Step 3: Simplify `updateTopupSummary` — no bonus, no total row**

Replace:

```js
function updateTopupSummary(amount) {
  const bonus = amount >= 100 ? amount * 0.20 : amount >= 50 ? amount * 0.15 : amount >= 25 ? amount * 0.10 : 0;
  const total = amount + bonus;
  const amtEl = document.getElementById('modalAmountDisplay');
  const bonusEl = document.getElementById('modalBonus');
  const totalEl = document.getElementById('modalTotal');
  if (amtEl) amtEl.textContent = fmtNaira(amount);
  if (bonusEl) bonusEl.textContent = bonus > 0 ? '+' + fmtNaira(bonus) : '+₦0';
  if (totalEl) totalEl.textContent = fmtNaira(total);
}
```

with:

```js
function updateTopupSummary(amount) {
  const amtEl = document.getElementById('modalAmountDisplay');
  if (amtEl) amtEl.textContent = fmtNaira(amount);
}
```

(Task 8 removes the now-unused `modalBonus`/`modalTotal` elements from the modal HTML.)

- [ ] **Step 4: Update `selectTopup` and `onCustomAmountInput` — amounts are already Naira**

Replace:

```js
function selectTopup(el, amount) {
  el.closest('.topup-grid').querySelectorAll('.topup-amount-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  state.selectedTopup = amount;

  const customWrap = document.getElementById('customAmountWrap');
  if (customWrap) customWrap.classList.toggle('hidden', amount !== 'custom');

  // Update modal summary (custom input is entered in Naira)
  if (amount === 'custom') {
    const naira = document.getElementById('customAmount')?.value || 0;
    updateTopupSummary(nairaToUsd(naira));
  } else {
    updateTopupSummary(parseFloat(amount));
  }
}
```

with:

```js
function selectTopup(el, amount) {
  el.closest('.topup-grid').querySelectorAll('.topup-amount-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  state.selectedTopup = amount;

  const customWrap = document.getElementById('customAmountWrap');
  if (customWrap) customWrap.classList.toggle('hidden', amount !== 'custom');

  if (amount === 'custom') {
    updateTopupSummary(parseFloat(document.getElementById('customAmount')?.value || 0));
  } else {
    updateTopupSummary(parseFloat(amount));
  }
}
```

Replace:

```js
// Live-update the summary when the user types a custom Naira amount.
function onCustomAmountInput(nairaVal) {
  updateTopupSummary(nairaToUsd(nairaVal));
}
```

with:

```js
// Live-update the summary when the user types a custom Naira amount.
function onCustomAmountInput(nairaVal) {
  updateTopupSummary(parseFloat(nairaVal) || 0);
}
```

- [ ] **Step 5: Delete `selectPayMethod` — no method choice left to make**

Delete:

```js
function selectPayMethod(el) {
  el.closest('.payment-methods').querySelectorAll('.pay-method').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
}
```

- [ ] **Step 6: Rewrite `processTopup` — single gateway, NGN amount, no bonus**

Replace:

```js
async function processTopup() {
  // Custom amount is entered in Naira → convert to USD for the backend.
  // Presets are already USD values.
  const amount = state.selectedTopup === 'custom'
    ? nairaToUsd(document.getElementById('customAmount')?.value || 0)
    : parseFloat(state.selectedTopup);

  if (!amount || amount < 1) {
    showToast(`Please enter a valid amount (min ${fmtNaira(1)})`, 'warning');
    return;
  }

  const bonus = amount >= 100 ? amount * 0.20 : amount >= 50 ? amount * 0.15 : amount >= 25 ? amount * 0.10 : 0;
  const total = amount + bonus;

  // Detect selected payment method
  const selected = document.querySelector('.pay-method.selected');
  const method = selected?.dataset?.method || 'nowpayments';
  const payCurrency = selected?.dataset?.currency || 'USDT';

  closeTopupModal();
  showToast('Redirecting to payment gateway...', 'info');

  try {
    const data = await api('POST', '/wallet/topup', { amount, method, payCurrency });
    if (!data) return;
    // Redirect to payment URL returned by backend
    const url = data.paymentUrl || data.url || data.checkoutUrl || data.invoiceUrl;
    if (url) {
      window.open(url, '_blank');
      showToast('Complete payment in the new tab. Your balance updates automatically.', 'info', 6000);
    } else {
      showToast('Payment initiated. Your balance will update once confirmed.', 'success');
    }
  } catch (err) {
    showToast(err.message || 'Payment initiation failed. Try again.', 'error');
  }
}
```

with:

```js
async function processTopup() {
  const amount = state.selectedTopup === 'custom'
    ? parseFloat(document.getElementById('customAmount')?.value || 0)
    : parseFloat(state.selectedTopup);

  if (!amount || amount < 1500) {
    showToast(`Please enter a valid amount (min ${fmtNaira(1500)})`, 'warning');
    return;
  }

  closeTopupModal();
  showToast('Redirecting to DrexPay...', 'info');

  try {
    const data = await api('POST', '/wallet/topup', { amount, method: 'drexpay' });
    if (!data) return;
    const url = data.payment && data.payment.url;
    if (url) {
      window.open(url, '_blank');
      showToast('Complete payment in the new tab. Your balance updates automatically.', 'info', 6000);
    } else {
      showToast('Payment initiated. Your balance will update once confirmed.', 'success');
    }
  } catch (err) {
    showToast(err.message || 'Payment initiation failed. Try again.', 'error');
  }
}
```

Note: the old fallback chain (`data.paymentUrl || data.url || data.checkoutUrl ||
data.invoiceUrl`) never actually matched any of the three removed gateways' real response
shapes (all three nested their URL/order-id under `data.payment.*`, e.g. PayPal's was
`data.payment.approvalUrl`, not `data.url`) — so top-up redirects likely silently fell through
to the "will update once confirmed" message for every gateway, every time. `data.payment.url`
above is the shape `walletController.initiateTopup` (Task 4) actually returns for DrexPay.

- [ ] **Step 7: Verify with the backend test suite**

`app.js` has no dedicated frontend test suite in this codebase (no build step, no browser test
runner configured) — the closest verification available from the command line is confirming the
backend contract this file now assumes is correct:

Run: `npx jest tests/wallet.test.js`
Expected: PASS — confirms `POST /api/wallet/topup` with `method: 'drexpay'` and the
`data.payment.url` response shape this file now relies on are what Task 4 actually built.

Manual verification happens in Task 9's final step, once the HTML changes (Task 8) make the
modal usable end-to-end in a browser.

- [ ] **Step 8: Commit**

```bash
git add public/app.js
git commit -m "$(cat <<'EOF'
Frontend: NGN-native currency display, single-gateway top-up flow

fmtNaira() no longer converts (backend returns NGN directly); fmtNGN
and nairaToUsd removed as redundant/obsolete. processTopup() drops the
bonus calculation and payment-method selection (DrexPay is now the only
option) and fixes the payment-URL field it reads to match what the
backend actually returns (data.payment.url) — the old fallback chain
never matched any of the three removed gateways either.
EOF
)"
```

---

### Task 8: Frontend — top-up UI markup (`public/index.html`)

**Files:**
- Modify: `public/index.html:1951-1957` (dashboard wallet-page topup grid)
- Modify: `public/index.html:2811-2849` (topup modal: amount grid, payment-method selector,
  summary block)
- Modify: `public/index.html:2117-2132` (Settings → Payment Methods panel)

**Interfaces:** None — markup only, consumed by Task 7's JS (`selectTopup`, `processTopup`,
`updateTopupSummary`), already updated.

- [ ] **Step 1: Update the dashboard wallet-page amount grid**

Replace (lines 1951-1957):

```html
              <div class="topup-grid">
                <div class="topup-amount-btn" onclick="selectTopup(this,'5')">$5</div>
                <div class="topup-amount-btn selected" onclick="selectTopup(this,'10')">$10</div>
                <div class="topup-amount-btn" onclick="selectTopup(this,'25')">$25 <span style="font-size:.65rem;color:var(--p-300);display:block">+10%</span></div>
                <div class="topup-amount-btn" onclick="selectTopup(this,'50')">$50 <span style="font-size:.65rem;color:var(--p-300);display:block">+15%</span></div>
                <div class="topup-amount-btn" onclick="selectTopup(this,'100')">$100 <span style="font-size:.65rem;color:var(--p-300);display:block">+20%</span></div>
                <div class="topup-amount-btn" onclick="selectTopup(this,'custom')">Custom</div>
              </div>
```

with:

```html
              <div class="topup-grid">
                <div class="topup-amount-btn" onclick="selectTopup(this,'2000')">₦2,000</div>
                <div class="topup-amount-btn selected" onclick="selectTopup(this,'5000')">₦5,000</div>
                <div class="topup-amount-btn" onclick="selectTopup(this,'10000')">₦10,000</div>
                <div class="topup-amount-btn" onclick="selectTopup(this,'25000')">₦25,000</div>
                <div class="topup-amount-btn" onclick="selectTopup(this,'50000')">₦50,000</div>
                <div class="topup-amount-btn" onclick="selectTopup(this,'custom')">Custom</div>
              </div>
```

- [ ] **Step 2: Update the topup modal — amount grid, drop the payment-method selector, simplify the summary**

Replace (lines 2811-2849, the entire region from the amount grid through the summary block,
up to but not including the `<button class="btn btn-primary btn-lg w-full"
onclick="processTopup()">` line):

```html
      <div class="topup-grid">
        <div class="topup-amount-btn" onclick="selectTopup(this,'5')">$5</div>
        <div class="topup-amount-btn selected" onclick="selectTopup(this,'10')">$10</div>
        <div class="topup-amount-btn" onclick="selectTopup(this,'25')">$25<br><span style="font-size:.65rem;color:var(--p-300)">+10% bonus</span></div>
        <div class="topup-amount-btn" onclick="selectTopup(this,'50')">$50<br><span style="font-size:.65rem;color:var(--p-300)">+15% bonus</span></div>
        <div class="topup-amount-btn" onclick="selectTopup(this,'100')">$100<br><span style="font-size:.65rem;color:var(--p-300)">+20% bonus</span></div>
        <div class="topup-amount-btn" onclick="selectTopup(this,'custom')">Custom</div>
      </div>
      <div id="customAmountWrap" class="hidden" style="margin-top:10px">
        <input type="number" class="form-input" placeholder="Enter amount in ₦ (min ₦1,600)" min="1600" step="100" id="customAmount" oninput="onCustomAmountInput(this.value)"/>
      </div>
    </div>
    <div style="margin-bottom:20px">
      <label class="form-label" style="margin-bottom:10px;display:block">Payment Method</label>
      <div class="payment-methods">
        <div class="pay-method selected" onclick="selectPayMethod(this)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#26A17B"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 13.5v.5h-1v-.5c-1.66-.17-2.5-1-2.5-1l.84-1.14s.64.64 1.66.64c.76 0 1-.28 1-.6 0-.45-.54-.6-1.3-.83C10.36 12.18 9 11.7 9 10.3c0-1.2.94-1.94 2-2.12V7.75h1v.43c1.34.18 2 .95 2 .95l-.84 1.13s-.5-.58-1.5-.58c-.63 0-.93.28-.93.6 0 .42.5.57 1.24.8C13.5 11.4 15 11.9 15 13.3c0 1.3-1 2.02-2 2.2z"/></svg>
          USDT / Crypto
        </div>
        <div class="pay-method" onclick="selectPayMethod(this)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#003087"><path d="M7.1 11.3h1.5c.6 0 1-.2 1.2-.5.2-.3.3-.7.2-1.1-.1-.4-.4-.7-.8-.8H7.7l-.6 2.4zm-.8 3.2h1.6c.7 0 1.2-.2 1.4-.6.2-.4.3-.8.2-1.2-.1-.4-.4-.7-.9-.8H7l-.7 2.6zM20 7H4c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2z"/></svg>
          PayPal
        </div>
        <div class="pay-method" onclick="selectPayMethod(this)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M2 10h20" stroke="currentColor" stroke-width="1.5"/></svg>
          Credit Card
        </div>
        <div class="pay-method" onclick="selectPayMethod(this)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#F7931A"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.7 7.3c.4.8.4 1.7 0 2.5.6.4 1 1.1.9 1.9-.1 1.3-1.2 2-2.5 2H9V8.2h2.9c1.2 0 2 .5 1.8 1.1z"/></svg>
          Bitcoin
        </div>
      </div>
    </div>
    <div style="background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px;margin-bottom:20px;font-size:.85rem">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="color:var(--txt-4)">Top-up amount</span><span id="modalAmountDisplay">$10.00</span></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="color:var(--txt-4)">Bonus credits</span><span style="color:var(--success)" id="modalBonus">+$0.00</span></div>
      <div style="height:1px;background:var(--border);margin:8px 0"></div>
      <div style="display:flex;justify-content:space-between;font-weight:700"><span>Total credited</span><span class="text-gradient" id="modalTotal">$10.00</span></div>
    </div>
```

with:

```html
      <div class="topup-grid">
        <div class="topup-amount-btn" onclick="selectTopup(this,'2000')">₦2,000</div>
        <div class="topup-amount-btn selected" onclick="selectTopup(this,'5000')">₦5,000</div>
        <div class="topup-amount-btn" onclick="selectTopup(this,'10000')">₦10,000</div>
        <div class="topup-amount-btn" onclick="selectTopup(this,'25000')">₦25,000</div>
        <div class="topup-amount-btn" onclick="selectTopup(this,'50000')">₦50,000</div>
        <div class="topup-amount-btn" onclick="selectTopup(this,'custom')">Custom</div>
      </div>
      <div id="customAmountWrap" class="hidden" style="margin-top:10px">
        <input type="number" class="form-input" placeholder="Enter amount in ₦ (min ₦1,500)" min="1500" step="100" id="customAmount" oninput="onCustomAmountInput(this.value)"/>
      </div>
    </div>
    <div style="background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px;margin-bottom:20px;font-size:.85rem">
      <div style="display:flex;justify-content:space-between;font-weight:700"><span>Top-up amount</span><span class="text-gradient" id="modalAmountDisplay">₦5,000</span></div>
    </div>
    <div style="color:var(--txt-4);font-size:.8rem;margin-bottom:16px;text-align:center">Paid via bank transfer through DrexPay — confirmed automatically.</div>
```

This removes the entire "Payment Method" selector (no choice needed — DrexPay is the only
gateway, all four `pay-method` divs including the Bitcoin one go) and the `modalBonus`/
`modalTotal` summary rows (Task 7 already stopped populating them).

- [ ] **Step 3: Update the Settings → Payment Methods panel**

Replace (lines 2117-2132):

```html
              <!-- Payment Methods -->
              <div class="settings-panel hidden" id="settings-payments">
                <div class="card mb-6">
                  <div style="font-weight:700;font-size:1.05rem;margin-bottom:6px">Payment Methods</div>
                  <div style="color:var(--txt-4);font-size:.85rem;margin-bottom:22px">No card is stored — you pay at top-up time. Accepted methods:</div>
                  <div style="display:flex;flex-direction:column;gap:10px">
                    <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--bg-3);border:1px solid var(--border-2);border-radius:var(--radius-md)">
                      <span style="font-size:1.1rem">₿</span><span>Crypto — USDT, BTC, ETH, BNB, Litecoin</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--bg-3);border:1px solid var(--border-2);border-radius:var(--radius-md)">
                      <span style="font-size:1.1rem">🏦</span><span>Bank transfer & card (at checkout)</span>
                    </div>
                  </div>
                  <button class="btn btn-primary" style="margin-top:20px" onclick="dashNav('wallet')">Go to Wallet & Top Up</button>
                </div>
              </div>
```

with:

```html
              <!-- Payment Methods -->
              <div class="settings-panel hidden" id="settings-payments">
                <div class="card mb-6">
                  <div style="font-weight:700;font-size:1.05rem;margin-bottom:6px">Payment Methods</div>
                  <div style="color:var(--txt-4);font-size:.85rem;margin-bottom:22px">Top-ups are processed via DrexPay bank transfer:</div>
                  <div style="display:flex;flex-direction:column;gap:10px">
                    <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--bg-3);border:1px solid var(--border-2);border-radius:var(--radius-md)">
                      <span style="font-size:1.1rem">🏦</span><span>Bank Transfer (NGN) — confirmed automatically</span>
                    </div>
                  </div>
                  <button class="btn btn-primary" style="margin-top:20px" onclick="dashNav('wallet')">Go to Wallet & Top Up</button>
                </div>
              </div>
```

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "$(cat <<'EOF'
Frontend: simplify top-up UI to DrexPay-only, NGN amounts, no bonus

Removes the payment-method selector (no choice left to make) and the
bonus/total summary rows. Both topup-amount grids (wallet page + modal)
now show NGN presets.
EOF
)"
```

---

### Task 9: Frontend — marketing copy and support content

**Files:**
- Modify: `public/index.html` (meta description; feature/step descriptions; pricing cards;
  accepted-payment-methods block)
- Modify: `public/app.js` (FAQ answer; chatbot canned reply)

**Interfaces:** None — copy only.

- [ ] **Step 1: Update `public/index.html` meta description (line 7)**

Change:
```html
<meta name="description" content="DonPeeSMS — Buy instant international WhatsApp and SMS verification numbers from 150+ countries. Secure, fast, anonymous, and affordable. Pay with crypto, card, or PayPal."/>
```
to:
```html
<meta name="description" content="DonPeeSMS — Buy instant international WhatsApp and SMS verification numbers from 150+ countries. Secure, fast, anonymous, and affordable. Top up your wallet via bank transfer."/>
```

- [ ] **Step 2: Update feature/step description copy**

Line 315:
```html
          <div class="feature-desc">Top up your wallet with USDT, Bitcoin, bank transfer, PayPal, or card. Your balance never expires.</div>
```
→
```html
          <div class="feature-desc">Top up your wallet via bank transfer through DrexPay. Your balance never expires.</div>
```

Line 415:
```html
          <div class="step-desc">Top up your account balance using crypto, PayPal, bank transfer, or card. Minimum deposit just $1.</div>
```
→
```html
          <div class="step-desc">Top up your account balance via bank transfer. Minimum deposit just ₦1,500.</div>
```

Line 418:
```html
            <li><svg width="12" height="12" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> PayPal &amp; card payments</li>
```
→
```html
            <li><svg width="12" height="12" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Instant bank transfer confirmation</li>
```

- [ ] **Step 3: Update the pricing cards (Pro / Business tiers)**

Replace (lines 731-744, the "Pro" card):

```html
        <div class="pricing-card popular">
          <div class="pricing-plan">Pro</div>
          <div class="pricing-amount"><sup>$</sup>25</div>
          <div class="pricing-per">wallet top-up · 10% bonus credits</div>
          <div class="pricing-divider"></div>
          <ul class="pricing-list">
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> <b>$27.50</b> wallet credit (10% bonus)</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> All Starter features</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Priority number allocation</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Bulk purchase dashboard</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Priority live chat support</li>
          </ul>
          <button class="btn btn-primary w-full" onclick="showPage('register')">Top Up $25</button>
        </div>
```

with:

```html
        <div class="pricing-card popular">
          <div class="pricing-plan">Pro</div>
          <div class="pricing-amount"><sup>₦</sup>40,000</div>
          <div class="pricing-per">wallet top-up</div>
          <div class="pricing-divider"></div>
          <ul class="pricing-list">
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> <b>₦40,000</b> wallet credit</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> All Starter features</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Priority number allocation</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Bulk purchase dashboard</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Priority live chat support</li>
          </ul>
          <button class="btn btn-primary w-full" onclick="showPage('register')">Top Up ₦40,000</button>
        </div>
```

Replace (lines 747-760, the "Business" card):

```html
        <div class="pricing-card">
          <div class="pricing-plan">Business</div>
          <div class="pricing-amount"><sup>$</sup>100</div>
          <div class="pricing-per">wallet top-up · 20% bonus credits</div>
          <div class="pricing-divider"></div>
          <ul class="pricing-list">
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> <b>$120</b> wallet credit (20% bonus)</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> All Pro features</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Full REST API access</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Dedicated account manager</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Custom pricing for 1000+ numbers</li>
          </ul>
          <button class="btn btn-outline w-full" onclick="showPage('register')">Top Up $100</button>
        </div>
```

with:

```html
        <div class="pricing-card">
          <div class="pricing-plan">Business</div>
          <div class="pricing-amount"><sup>₦</sup>160,000</div>
          <div class="pricing-per">wallet top-up</div>
          <div class="pricing-divider"></div>
          <ul class="pricing-list">
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> <b>₦160,000</b> wallet credit</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> All Pro features</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Full REST API access</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Dedicated account manager</li>
            <li><svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Custom pricing for 1000+ numbers</li>
          </ul>
          <button class="btn btn-outline w-full" onclick="showPage('register')">Top Up ₦160,000</button>
        </div>
```

(`<sup>₦</sup>` reuses the existing `.pricing-amount sup { font-size: 1rem; vertical-align:
super; }` rule in `public/styles.css:757` — no new styling needed, same pattern the `$` symbol
used.)

- [ ] **Step 4: Update the "Accepted Payment Methods" block**

Replace (lines 764-803):

```html
      <div class="pay-methods-block">
        <div style="font-size:.8rem;color:var(--txt-4);text-transform:uppercase;letter-spacing:.1em;margin-bottom:18px;text-align:center">Accepted Payment Methods</div>
        <div class="pay-methods-row">
          <div class="pay-method-pill">
            <img src="https://cdn.simpleicons.org/tether/26A17B" width="18" height="18" alt="USDT"/>
            USDT
          </div>
          <div class="pay-method-pill">
            <img src="https://cdn.simpleicons.org/bitcoin/F7931A" width="18" height="18" alt="BTC"/>
            Bitcoin
          </div>
          <div class="pay-method-pill">
            <img src="https://cdn.simpleicons.org/ethereum/627EEA" width="18" height="18" alt="ETH"/>
            Ethereum
          </div>
          <div class="pay-method-pill">
            <img src="https://cdn.simpleicons.org/paypal/003087" width="18" height="18" alt="PayPal"/>
            PayPal
          </div>
          <div class="pay-method-pill">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="1" y="4" width="22" height="16" rx="3" stroke="var(--txt-3)" stroke-width="1.5"/><path d="M1 10h22" stroke="var(--txt-3)" stroke-width="1.5"/></svg>
            Visa / Mastercard
          </div>
          <div class="pay-method-pill">
            <img src="https://cdn.simpleicons.org/binance/F0B90B" width="18" height="18" alt="BNB"/>
            BNB
          </div>
          <div class="pay-method-pill">
            <img src="https://cdn.simpleicons.org/litecoin/345D9D" width="18" height="18" alt="LTC"/>
            Litecoin
          </div>
          <div class="pay-method-pill">
            <svg width="18" height="18" fill="none" stroke="var(--txt-3)" stroke-width="1.5" viewBox="0 0 24 24"><path d="M3 3h18v4H3zM3 17h18v4H3z"/><path d="M7 12h10M7 12l2-2M7 12l2 2" stroke-linecap="round"/></svg>
            Bank Transfer
          </div>
        </div>
        <div style="text-align:center;margin-top:16px;font-size:.83rem;color:var(--txt-4)">
          All crypto payments processed instantly via NowPayments. No extra fees for crypto topups.
        </div>
      </div>
```

with:

```html
      <div class="pay-methods-block">
        <div style="font-size:.8rem;color:var(--txt-4);text-transform:uppercase;letter-spacing:.1em;margin-bottom:18px;text-align:center">Accepted Payment Method</div>
        <div class="pay-methods-row">
          <div class="pay-method-pill">
            <svg width="18" height="18" fill="none" stroke="var(--txt-3)" stroke-width="1.5" viewBox="0 0 24 24"><path d="M3 3h18v4H3zM3 17h18v4H3z"/><path d="M7 12h10M7 12l2-2M7 12l2 2" stroke-linecap="round"/></svg>
            Bank Transfer (NGN)
          </div>
        </div>
        <div style="text-align:center;margin-top:16px;font-size:.83rem;color:var(--txt-4)">
          All payments processed via DrexPay and confirmed automatically. No extra fees.
        </div>
      </div>
```

- [ ] **Step 5: Update the FAQ answer in `public/app.js` (line 1352)**

Change:
```js
  { q:'What payment methods are accepted?', a:'We accept USDT (TRC20/ERC20), Bitcoin, Ethereum, BNB, Litecoin, PayPal, bank transfers, Visa, and Mastercard. Crypto payments are instant with zero extra fees. Your wallet balance never expires.' },
```
to:
```js
  { q:'What payment methods are accepted?', a:'We accept Nigerian bank transfer via DrexPay — fast, secure, and confirmed automatically. Your wallet balance never expires.' },
```

- [ ] **Step 6: Update the chatbot canned reply (lines 1780-1789)**

Change:
```js
  {
    keys: ['pay','payment','crypto','bitcoin','btc','card','paypal','usdt','ethereum','deposit','fund','wallet','top up'],
    reply: `We accept multiple payment methods: 💳<br><br>
      • <strong>Crypto</strong> – Bitcoin, USDT, Ethereum & more<br>
      • <strong>Debit/Credit Card</strong> – Visa, Mastercard<br>
      • <strong>PayPal</strong><br>
      • <strong>Bank Transfer</strong><br><br>
      All payments are secure and instant. Your wallet is credited immediately! 🔒`,
    wa: 'Hi DonPeeSMS, I have a payment question'
  },
```
to:
```js
  {
    keys: ['pay','payment','card','deposit','fund','wallet','top up','bank','transfer'],
    reply: `We accept payment via <strong>Bank Transfer</strong> through DrexPay: 🏦<br><br>
      Top up your wallet, complete the transfer, and your balance updates automatically once
      confirmed — usually within minutes.<br><br>
      All payments are secure. 🔒`,
    wa: 'Hi DonPeeSMS, I have a payment question'
  },
```

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js
git commit -m "$(cat <<'EOF'
Update marketing copy, FAQ, and chatbot replies for DrexPay-only, no-bonus reality
EOF
)"
```

---

### Task 10: Update smoke test, final full-suite verification

**Files:**
- Modify: `tests/smoke.test.js:110`

**Interfaces:** None — final verification task.

- [ ] **Step 1: Update the smoke test's topup fixture**

Change:
```js
      .send({ amount: 10, method: 'stripe' })
```
to:
```js
      .send({ amount: 10, method: 'drexpay' })
```

- [ ] **Step 2: Run the full test suite**

Run: `npx jest`
Expected: PASS — every suite green (`auth`, `caseMapper`, `config`, `errorHandler`, `smoke`,
`wallet`, `telegramService`, `smsProvider`, `drexpayService`, `drexpayWebhook`).

- [ ] **Step 3: Grep for any remaining stray references**

Run: `grep -rln "stripe\|paypal\|nowpayments\|NowPayments\|PayPal\|Stripe" --include="*.js" --include="*.html" -i . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.worktrees --exclude-dir=.claude`

Expected: only doc/spec/plan files under `docs/` should show up (this plan and the design doc
themselves reference the old gateway names in the "removed" narrative — that's correct and
expected). If any `.js`/`.html` file outside `docs/` still shows a match, read it and decide
whether Task 9's copy pass missed it.

- [ ] **Step 4: Commit**

```bash
git add tests/smoke.test.js
git commit -m "$(cat <<'EOF'
Update smoke test topup fixture to method: 'drexpay'
EOF
)"
```
