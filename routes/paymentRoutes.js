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
