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
