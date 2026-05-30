/**
 * PayPal service — order creation + capture via Checkout SDK
 */
const paypal = require('@paypal/checkout-server-sdk');
const env = require('../config/env');
const logger = require('../utils/logger');
const ApiError = require('../utils/apiError');

let client = null;

const getClient = () => {
  if (client) return client;
  if (!env.paypal.clientId) throw ApiError.internal('PayPal not configured');

  const envObj = env.paypal.mode === 'live'
    ? new paypal.core.LiveEnvironment(env.paypal.clientId, env.paypal.clientSecret)
    : new paypal.core.SandboxEnvironment(env.paypal.clientId, env.paypal.clientSecret);

  client = new paypal.core.PayPalHttpClient(envObj);
  return client;
};

const createOrder = async ({ userId, amount, bonus = 0 }) => {
  const c = getClient();
  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer('return=representation');
  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: `topup-${userId}-${Date.now()}`,
      amount: {
        currency_code: 'USD',
        value: amount.toFixed(2)
      },
      description: `DonPeeSMS wallet top-up${bonus > 0 ? ` (+$${bonus.toFixed(2)} bonus)` : ''}`,
      custom_id: JSON.stringify({ userId: String(userId), amount, bonus })
    }],
    application_context: {
      brand_name: env.appName,
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      return_url: `${env.frontendUrl}/dashboard?topup=paypal_success`,
      cancel_url: `${env.frontendUrl}/dashboard?topup=cancelled`
    }
  });

  const response = await c.execute(request);
  return {
    orderId: response.result.id,
    status: response.result.status,
    approvalUrl: response.result.links.find(l => l.rel === 'approve')?.href
  };
};

const captureOrder = async (paypalOrderId) => {
  const c = getClient();
  const request = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
  request.requestBody({});
  const response = await c.execute(request);
  return response.result;
};

const getOrder = async (paypalOrderId) => {
  const c = getClient();
  const request = new paypal.orders.OrdersGetRequest(paypalOrderId);
  const response = await c.execute(request);
  return response.result;
};

module.exports = { createOrder, captureOrder, getOrder };
