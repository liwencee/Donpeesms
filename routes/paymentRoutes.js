/**
 * Payment routes — webhooks + capture endpoints
 */
const router = require('express').Router();
const express = require('express');
const { protect } = require('../middleware/auth');
const { webhookLimiter } = require('../middleware/rateLimiter');
const stripeWebhook = require('../webhooks/stripeWebhook');
const npWebhook = require('../webhooks/nowPaymentsWebhook');
const paypalWebhook = require('../webhooks/paypalWebhook');

// ── WEBHOOKS (RAW body for signature verification) ──
router.post('/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  webhookLimiter,
  stripeWebhook);

router.post('/webhooks/nowpayments',
  express.raw({ type: 'application/json' }),
  webhookLimiter,
  npWebhook);

router.post('/webhooks/paypal',
  express.json(),
  webhookLimiter,
  paypalWebhook.webhook);

// ── PAYPAL CAPTURE (frontend-triggered after approval) ──
router.post('/paypal/capture',
  express.json(),
  protect,
  paypalWebhook.capturePayment);

module.exports = router;
