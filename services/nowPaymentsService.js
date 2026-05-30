/**
 * NowPayments service — crypto payments (USDT, BTC, ETH, etc.)
 * https://documenter.getpostman.com/view/7907941/2s9YsGit3R
 */
const axios = require('axios');
const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');
const ApiError = require('../utils/apiError');

const client = () => axios.create({
  baseURL: env.nowPayments.baseUrl,
  headers: {
    'x-api-key': env.nowPayments.apiKey,
    'Content-Type': 'application/json'
  },
  timeout: 15000
});

const getStatus = async () => {
  if (!env.nowPayments.apiKey) throw ApiError.internal('NowPayments not configured');
  const { data } = await client().get('/status');
  return data;
};

const getAvailableCurrencies = async () => {
  const { data } = await client().get('/currencies');
  return data.currencies || [];
};

const getMinAmount = async (currencyFrom = 'usdttrc20', currencyTo = 'usd') => {
  const { data } = await client().get('/min-amount', {
    params: { currency_from: currencyFrom, currency_to: currencyTo }
  });
  return data;
};

const getEstimate = async (amount, currencyFrom = 'usd', currencyTo = 'usdttrc20') => {
  const { data } = await client().get('/estimate', {
    params: { amount, currency_from: currencyFrom, currency_to: currencyTo }
  });
  return data;
};

/**
 * Create a payment — user is shown a wallet address + amount in crypto
 */
const createPayment = async ({ userId, amount, bonus = 0, payCurrency = 'usdttrc20' }) => {
  if (!env.nowPayments.apiKey) throw ApiError.internal('NowPayments not configured');

  const { data } = await client().post('/payment', {
    price_amount: amount,
    price_currency: 'usd',
    pay_currency: payCurrency,
    order_id: `topup-${userId}-${Date.now()}`,
    order_description: `DonPeeSMS wallet top-up ($${amount})`,
    ipn_callback_url: `${env.backendUrl}/api/webhooks/nowpayments`,
    success_url: `${env.frontendUrl}/dashboard?topup=success`,
    cancel_url:  `${env.frontendUrl}/dashboard?topup=cancelled`
  });

  return {
    paymentId:    data.payment_id,
    status:       data.payment_status,
    payAddress:   data.pay_address,
    payAmount:    data.pay_amount,
    payCurrency:  data.pay_currency,
    priceAmount:  data.price_amount,
    priceCurrency:data.price_currency,
    expiresAt:    data.expiration_estimate_date,
    metadata:     { userId, amount, bonus }
  };
};

const getPayment = async (paymentId) => {
  const { data } = await client().get(`/payment/${paymentId}`);
  return data;
};

/**
 * Verify IPN signature
 * Body must be raw JSON. Header: x-nowpayments-sig
 */
const verifyIpnSignature = (rawBody, signature) => {
  if (!env.nowPayments.ipnSecret) {
    logger.warn('NowPayments IPN secret not set — skipping signature verification');
    return true;
  }
  const sorted = sortObject(typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody);
  const hmac = crypto.createHmac('sha512', env.nowPayments.ipnSecret);
  hmac.update(JSON.stringify(sorted));
  const computed = hmac.digest('hex');
  return computed === signature;
};

const sortObject = (obj) => {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj === null || typeof obj !== 'object') return obj;
  return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortObject(obj[k]); return acc; }, {});
};

module.exports = {
  getStatus,
  getAvailableCurrencies,
  getMinAmount,
  getEstimate,
  createPayment,
  getPayment,
  verifyIpnSignature
};
