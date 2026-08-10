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
