/**
 * Stripe service — card payments via Payment Intents + Checkout Sessions
 */
const Stripe = require('stripe');
const env = require('../config/env');
const logger = require('../utils/logger');
const ApiError = require('../utils/apiError');

let stripe = null;
const getStripe = () => {
  if (!stripe) {
    if (!env.stripe.secret) throw ApiError.internal('Stripe not configured');
    stripe = Stripe(env.stripe.secret, { apiVersion: '2024-06-20' });
  }
  return stripe;
};

/**
 * Create a Stripe Checkout Session for a wallet top-up
 */
const createCheckoutSession = async ({ userId, email, amount, bonus = 0 }) => {
  const s = getStripe();
  const totalCents = Math.round(amount * 100);

  const session = await s.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    customer_email: email,
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'DonPeeSMS Wallet Top-up',
          description: bonus > 0 ? `Includes $${bonus.toFixed(2)} bonus credit` : 'Add funds to your DonPeeSMS wallet'
        },
        unit_amount: totalCents
      },
      quantity: 1
    }],
    metadata: {
      userId: String(userId),
      amount: String(amount),
      bonus: String(bonus),
      purpose: 'wallet_topup'
    },
    success_url: `${env.frontendUrl}/dashboard?topup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${env.frontendUrl}/dashboard?topup=cancelled`
  });

  return { sessionId: session.id, url: session.url };
};

/**
 * Create a Payment Intent (for custom checkout flows)
 */
const createPaymentIntent = async ({ userId, amount, bonus = 0 }) => {
  const s = getStripe();
  const intent = await s.paymentIntents.create({
    amount: Math.round(amount * 100),
    currency: 'usd',
    automatic_payment_methods: { enabled: true },
    metadata: {
      userId: String(userId),
      amount: String(amount),
      bonus: String(bonus),
      purpose: 'wallet_topup'
    }
  });
  return { clientSecret: intent.client_secret, paymentIntentId: intent.id };
};

/**
 * Verify webhook signature
 */
const verifyWebhook = (rawBody, signature) => {
  const s = getStripe();
  try {
    return s.webhooks.constructEvent(rawBody, signature, env.stripe.webhookSecret);
  } catch (err) {
    logger.error('Stripe webhook verification failed:', err.message);
    throw ApiError.badRequest('Invalid webhook signature');
  }
};

/**
 * Refund a payment
 */
const refund = async (paymentIntentId, amount) => {
  const s = getStripe();
  return s.refunds.create({
    payment_intent: paymentIntentId,
    amount: amount ? Math.round(amount * 100) : undefined
  });
};

module.exports = { createCheckoutSession, createPaymentIntent, verifyWebhook, refund, getStripe };
