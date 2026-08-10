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

// HMAC-SHA512 over the raw request body, hex digest, compared against the
// x-drexpay-signature header. Confirmed directly against DrexPay's
// merchant-dashboard webhook docs (payment webhook section) — this is not
// a canonicalized/sorted-JSON scheme, it's the raw bytes as received.
const verifyWebhookSignature = (rawBody, signature) => {
  if (!env.drexpay.webhookSecret || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const computed = crypto.createHmac('sha512', env.drexpay.webhookSecret).update(body).digest('hex');
  return computed === signature;
};

module.exports = { createPaymentLink, verifyWebhookSignature };
