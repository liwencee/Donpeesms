# DrexPay payment migration — design

**Date:** 2026-08-06
**Status:** Approved, not yet implemented

## Purpose

Replace Stripe, PayPal, and NowPayments with DrexPay (`drexpay.tech`) as the sole wallet
top-up gateway, and make Naira the wallet's real backend unit instead of a display mask over
USD.

## Why this is two changes, not one

The obvious reading of "swap the payment gateway" is a same-shape service swap. It isn't,
because of what's already in `public/app.js`:

```js
// All backend amounts are stored in USD; the UI shows Naira.
// Change NGN_RATE here to update the exchange rate everywhere.
const NGN_RATE = 1600;
```

`fmtNaira()` multiplies by 1600 for display; `nairaToUsd()` divides by 1600 when a user types
a Naira amount into a form. The backend (`wallet_balance`, `transactions.amount`, order costs)
has only ever stored USD — Naira is paint. DrexPay only speaks NGN (bank transfer, no cards).
If the gateway were swapped without touching this, a real ₦50,000 top-up would get credited
to the wallet as raw `+50000`, which the existing display layer would then multiply by 1600
*again* on render. That's not a hypothetical edge case, it's what happens on the very first
top-up. So this design makes NGN the backend's real unit — approved as "Approach A" — and the
gateway swap rides along with it, because DrexPay only makes sense once that's true.

## Scope

**In scope:**
- Remove `stripeService.js`, `paypalService.js`, `nowPaymentsService.js`, their webhook
  handlers, their routes, their npm packages, and their `.env.example` entries.
- Add `services/drexpayService.js` + `webhooks/drexpayWebhook.js`, wired into
  `routes/paymentRoutes.js` the same way the removed gateways were.
- Migrate the wallet/transaction/order currency model from USD to NGN (see below).
- Move `NGN_RATE` from a frontend-only display constant to backend config, used at the one
  place a real external-currency conversion is still needed: converting SMS-provider costs
  (5SIM/SMS-Activate return RUB; other sub-providers return USD) into the NGN price charged to
  the user.

**Out of scope (considered, explicitly declined):**
- DrexPay's `/api/withdrawal` payout endpoint. Nothing in this app pays money out today
  (Stripe `refund()` was the only payout-shaped call, and DrexPay's docs don't show a refund
  endpoint at all — see Error Handling). Adding payouts is a separate feature.
- Live/real-time FX rate lookup. `NGN_RATE` stays a manually-set config value, matching how
  `priceMarkup` already works in `config/env.js` — this codebase has no precedent for live FX
  and this migration isn't the place to add one.
- An abandoned-payment sweep job. DrexPay payment-links that time out (30 min, no transfer)
  send no webhook at all, so those transactions stay `'pending'` forever unless someone builds
  a poller — but that's equally true of the three gateways being removed today (no expiry job
  exists for them either). Not a regression, so not being fixed here.
- Rewriting historical transaction/order rows. See Data Migration below — old rows keep their
  own recorded currency instead of being bulk-converted.

## Architecture

```
public/app.js (top-up form)
  └─ user enters a Naira amount directly, no client-side conversion
       └─ POST /api/wallet/topup { amount, method: 'drexpay' }
             └─ walletController.initiateTopup
                   ├─ insert transactions row: status='pending', currency='NGN'
                   └─ drexpayService.createPaymentLink({ email, amount, reference })
                         └─ POST https://drexpay.tech/api/payment-links
                               └─ returns { id, url, reference }
                                     └─ user redirected to hosted `url`, pays via bank transfer

DrexPay ──(async, on transfer received)──▶ POST /api/payments/webhooks/drexpay
                                                 ├─ verify x-drexpay-signature (HMAC-SHA512)
                                                 ├─ look up transactions row by external_id=reference, status='pending'
                                                 ├─ charge.success → walletController.creditWallet(pending row's amount/bonus)
                                                 └─ charge.failed  → mark transaction 'failed'
```

This is the same shape the three removed gateways already used — a `transactions` row created
`'pending'` at initiation, looked up by `external_id` when the webhook lands, credited from
*our own stored amount*, never from whatever the webhook claims. DrexPay's webhook is
actually thinner than Stripe's or NowPayments' (`{ event, data: { reference } }` — no amount,
no email), which fits this pattern cleanly: we were already ignoring the webhook's amount in
favor of our own pending row for Stripe and NowPayments, and DrexPay just doesn't give us the
option to do otherwise.

Note for implementation: the webhook URL must be registered as
`{backendUrl}/api/payments/webhooks/drexpay` (full mount path). While reading
`nowPaymentsService.js` I found its configured `ipn_callback_url` is
`{backendUrl}/api/webhooks/nowpayments` — missing the `/payments` segment that
`app.use('/api/payments', paymentRoutes)` actually requires, so NowPayments' webhook has
likely never reached this server. Moot once `nowPaymentsService.js` is deleted, but flagging
so the same mistake doesn't get repeated for DrexPay.

## Components

### Currency migration

- **`supabase/migrations/0005_ngn_migration.sql`** (new): one-time `update profiles set
  wallet_balance = wallet_balance * 1600` to preserve every existing user's real balance
  (a $50 balance becomes ₦80,000 — same purchasing power, new unit) — **this must land in the
  same deploy as the code change**, not before or after, since `profiles.wallet_balance` is a
  single running total with no per-row currency tag. Unlike wallet_balance, `transactions.amount`
  and `orders.user_cost` sit next to their own `currency` column already (`text not null default
  'USD'`) — those are left untouched; only the column *default* flips to `'NGN'` for rows
  inserted from here on. Old rows keep saying `'USD'` and keep their true historical USD
  amounts; they're a correct record of what happened, not something to rewrite.
- **`config/env.js`**: add `ngnRate: parseFloat(process.env.NGN_RATE) || 1600`, next to the
  existing `priceMarkup` entry it mirrors.
- **`services/smsProvider.js`**: `calculateUserPrice(providerCost)` gets the conversion folded
  in — `providerCost * env.priceMarkup * env.ngnRate`, rounded. This is the one place a real
  currency conversion belongs, since provider costs genuinely arrive in RUB/USD.
- **`controllers/walletController.js`**: `getWallet` returns `currency: 'NGN'`. Per user
  decision, top-ups no longer carry a bonus — `calculateBonus` is simplified to always `return
  0` rather than being deleted outright, since `bonus`/`bonusAmount` still flows through
  `initiateTopup`, `creditWallet`, the `transactions.bonus_amount` column, and the email
  template's `tx.bonusAmount > 0` conditional line; forcing the source to 0 makes all of that
  correctly inert without touching schema or those other call sites. `initiateTopup`'s $1 min /
  $10,000 max move to proposed ₦1,500 min / ₦15,000,000 max — a starting proposal, not a precise
  peg, adjust freely.
- **`services/emailService.js`** and **`controllers/numberController.js`**: `$${...}` strings
  (order-active email, topup-confirmation email, insufficient-balance error message) become
  `₦${...}`.
- **`public/app.js`**: `fmtNaira`/`nairaToUsd`/`NGN_RATE` removed. Wallet balance and order-cost
  display switch to calling `fmtNGN()` directly (already exists, already used for Product
  prices) — no conversion, since the backend value now *is* the Naira amount. Top-up form no
  longer converts input before sending it to the API.

### `services/drexpayService.js` (new)

Mirrors the shape of the services being removed: a thin axios wrapper reading its config from
`config/env.js`.

- `createPaymentLink({ email, amount })` → `POST /api/payment-links` with `{ email, amount,
  redirectTo: `${env.frontendUrl}/dashboard?topup=success` }` (matching the existing
  `success_url`/`return_url` pattern the removed gateways used) and
  `Authorization: Bearer {env.drexpay.secretKey}`. Returns `{ id, url, reference }` — DrexPay
  generates `reference`, the caller doesn't supply one; `walletController.initiateTopup` stores
  the *returned* reference as the transaction's `external_id`, same as it does today with
  Stripe's `session.id`.
- `verifyWebhookSignature(rawBody, signature)` → HMAC-SHA512 check against
  `env.drexpay.webhookSecret`. **Open item for the implementer:** DrexPay's docs confirm
  HMAC-SHA512 but the page fetched during this design didn't surface the exact
  payload-to-sign convention (raw body vs. a canonicalized/sorted form). Check the merchant
  dashboard's webhook docs directly before writing this — `nowPaymentsService.verifyIpnSignature`
  in this same codebase (HMAC-SHA512 over a key-sorted JSON body) is the closest existing
  template if DrexPay's docs don't spell it out explicitly.
- `env.drexpay = { secretKey: process.env.DREXPAY_SECRET_KEY, webhookSecret:
  process.env.DREXPAY_WEBHOOK_SECRET }`, following the existing `stripe`/`paypal` config-block
  pattern in `config/env.js`.

### `webhooks/drexpayWebhook.js` (new)

Raw-body route (signature verification needs the exact bytes, same reason Stripe's route uses
`express.raw`). On `charge.success`: look up the pending transaction by
`external_id = data.reference`, call `walletController.creditWallet` with *that row's* stored
amount/bonus (never trusting a webhook-supplied amount — DrexPay's webhook doesn't even send
one), mark the transaction `'success'`, send the existing top-up confirmation email. On
`charge.failed`: mark the transaction `'failed'`. Unrecognized `event` values: log and 200 (same
pattern Stripe's handler uses for events it doesn't act on).

### `routes/paymentRoutes.js`

Drop the Stripe/NowPayments/PayPal webhook routes and the PayPal capture route. Add:

```js
router.post('/webhooks/drexpay', express.raw({ type: 'application/json' }), webhookLimiter, drexpayWebhook);
```

No capture-style route is needed — DrexPay's hosted payment-link page is the entire user-facing
flow; there's nothing for the frontend to call after redirect, unlike PayPal's approve→capture
dance.

### Removal

Delete `services/stripeService.js`, `services/paypalService.js`, `services/nowPaymentsService.js`,
`webhooks/stripeWebhook.js`, `webhooks/nowPaymentsWebhook.js`, `webhooks/paypalWebhook.js`.
Remove `stripe` and `@paypal/checkout-server-sdk` from `package.json` (axios, already a
dependency, covers DrexPay). Remove the `STRIPE_*`, `NOWPAYMENTS_*`, `PAYPAL_*` blocks from
`.env.example`, replaced with a `DREXPAY_*` block. Remove the `stripe`/`paypal`/`nowPayments`
blocks from `config/env.js`, replaced with the `drexpay`/`ngnRate` entries described above.
`walletController.initiateTopup`'s `switch (method)` loses the `stripe`/`nowpayments`/`paypal`
cases and gains a `drexpay` case.

## Data flow

1. User enters a Naira amount in the top-up form (no client-side conversion — the number they
   type is the number that gets charged and credited).
2. `POST /api/wallet/topup { amount, method: 'drexpay' }` → transaction row inserted
   `status='pending'`, `currency='NGN'`.
3. `drexpayService.createPaymentLink` called with that amount; the returned `reference` is
   stored on the transaction row (`external_id`), mirroring how Stripe's `session.id` and
   NowPayments' `payment_id` are stored today.
4. User is redirected to DrexPay's hosted `url`, completes a bank transfer.
5. DrexPay POSTs the webhook once the transfer is confirmed (or fails) — no partial-payment
   case exists here the way NowPayments' crypto had `partially_paid`, since a payment-link is a
   fixed amount.
6. Webhook handler verifies signature, looks up the pending row by reference, credits the
   wallet with that row's amount/bonus, marks it `'success'`, fires the confirmation email —
   identical shape to the Stripe/NowPayments handlers being removed.

## Error handling

- **Invalid/missing webhook signature:** reject with 400, log, no wallet mutation — same as
  the Stripe and NowPayments handlers today.
- **Webhook for a reference with no matching pending transaction:** log and 200 (DrexPay
  should not retry-storm us for something we can't act on) — matches the existing "no pending
  tx" branches in the Stripe/NowPayments handlers.
- **`charge.failed`:** mark the transaction `'failed'`; user sees the existing failed/cancelled
  top-up state, no new UI needed.
- **Abandoned (30 min, no transfer, no webhook):** transaction stays `'pending'` indefinitely —
  explicitly out of scope per above, matches current behavior for the gateways being removed.
- **No refund endpoint in DrexPay's docs:** `stripeService.refund()` has no DrexPay equivalent.
  Nothing in the current codebase calls `stripeService.refund()` today (grep confirms it's
  unused outside its own module), so this removes no functionality that's actually wired up.
  If refunds are needed later, that's a new conversation with DrexPay's support/docs, not
  something this migration blocks on.

## Testing

- `tests/wallet.test.js`: existing tests use abstract numeric amounts (5, 10, 50, 100), not
  currency-formatted strings, so they stay valid as-is; update `method: 'stripe'/'paypal'`
  fixture values to `'drexpay'` where used for realism. Add a test asserting
  `calculateBonus(amount)` returns `0` regardless of amount, pinning the "no bonus" decision
  against regression.
- New `tests/drexpayService.test.js`: mocked-axios tests for `createPaymentLink` (correct URL,
  auth header, body) and `verifyWebhookSignature` (valid/invalid/missing signature) — follow
  the `tests/telegramService.test.js` mocking pattern (`jest.mock` once at top, no
  `resetModules`/`doMock`, matches this codebase's actual convention).
- New `tests/drexpayWebhook.test.js`: `charge.success` credits the right pending transaction;
  `charge.failed` marks it failed; bad signature → 400 + no credit; unknown reference → 200 +
  no credit.
- `tests/smoke.test.js`: currently asserts the app boots with the old gateway routes present —
  update to reflect DrexPay's route instead of Stripe/PayPal/NowPayments.

## Setup required from user (outside this codebase)

1. DrexPay merchant dashboard → Developer settings → get both a live secret key (`ngp_sk_...`)
   and a test key (`ngp_sk_test_...`) for sandbox verification before cutover.
2. Register the webhook URL in DrexPay's dashboard:
   `https://{your backend domain}/api/payments/webhooks/drexpay` (see Architecture note on the
   NowPayments URL mismatch — get this one right).
3. Get the webhook signing secret from the dashboard for `DREXPAY_WEBHOOK_SECRET`, and confirm
   the exact HMAC payload convention against DrexPay's docs (see open item under
   `drexpayService.js` above).
4. Set `DREXPAY_SECRET_KEY`, `DREXPAY_WEBHOOK_SECRET`, and optionally `NGN_RATE` (defaults to
   1600) in `.env` locally and in Hostinger's production environment variables.
5. Confirm or adjust the proposed NGN top-up min/max (₦1,500/₦15,000,000) before this ships —
   it's this design's proposal, not a requirement. (No bonus tiers to confirm — bonuses are
   disabled per user decision.)
6. Test end-to-end against DrexPay's sandbox (`ngp_sk_test_` key routes payments through their
   simulator) before switching the live key in production.
