/**
 * Rate limiters — global + auth-specific
 */
const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const globalLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.rateLimit.authMax,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' }
});

const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many purchase attempts. Slow down.' }
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100
});

module.exports = { globalLimiter, authLimiter, purchaseLimiter, webhookLimiter };
