/**
 * numberController.getPrice / buyNumber — the actual money path for
 * number purchases, previously untested and, it turned out, broken
 * against the real SureVerifications API (2-letter country codes and
 * lowercase service names like 'whatsapp' where the live API requires a
 * numeric country_id and an opaque per-service id — confirmed live, see
 * services/smsProvider.js). These lock in the fix: real country/service
 * resolution, the service allowlist (only names with a confirmed real
 * equivalent), the out-of-stock gate, and — critically — the NGN-only
 * price formula (SureVerifications' raw cost is already Naira; applying
 * the other providers' USD*ngnRate formula here produced ₦3.49M for one
 * WhatsApp number).
 */
jest.mock('../config/supabase', () => ({ supabase: { from: jest.fn() } }));
jest.mock('../services/smsProvider', () => ({
  ...jest.requireActual('../services/smsProvider'),
  getProvider: jest.fn()
}));
jest.mock('../controllers/walletController', () => ({ debitWallet: jest.fn() }));
// Real code does email.sendOrderConfirmation(...).catch(...) — the mock
// must resolve to something with .catch, not a bare undefined return.
jest.mock('../services/emailService', () => ({ sendOrderConfirmation: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/telegramService', () => ({ notifyPurchase: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { supabase } = require('../config/supabase');
const { getProvider } = require('../services/smsProvider');
const wallet = require('../controllers/walletController');
const numberController = require('../controllers/numberController');

const fakeProvider = (overrides = {}) => ({
  name: 'sureverifications',
  resolveCountryId: jest.fn().mockResolvedValue(159),
  resolveServiceId: jest.fn().mockResolvedValue('69c05c2e27c5759c68a8135e'),
  getServicePrice: jest.fn().mockResolvedValue({ cost: 1560, inStock: true, server: 'server1' }),
  buyNumberForService: jest.fn().mockResolvedValue({
    providerOrderId: 'po-1', phoneNumber: '+2348012345678', cost: 1560, expiresAt: new Date(), server: 'server1'
  }),
  ...overrides
});

const mockReqRes = (query = {}, body = {}, user = { id: 'u1', walletBalance: 100000 }) => {
  const req = { query, body, user, userId: user.id, ip: '127.0.0.1', get: () => 'jest' };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
};

beforeEach(() => jest.clearAllMocks());

describe('getPrice', () => {
  test('rejects a service with no real equivalent (e.g. the old "any" catch-all)', async () => {
    getProvider.mockReturnValue(fakeProvider());
    const { req, res, next } = mockReqRes({ country: 'NG', service: 'any' });
    await numberController.getPrice(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  test('requires both country and service', async () => {
    getProvider.mockReturnValue(fakeProvider());
    const { req, res, next } = mockReqRes({ country: 'NG' });
    await numberController.getPrice(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  test('resolves country + service through the provider and prices with the NGN-only formula (no ngnRate)', async () => {
    const provider = fakeProvider({ getServicePrice: jest.fn().mockResolvedValue({ cost: 1560, inStock: true, server: 'server1' }) });
    getProvider.mockReturnValue(provider);
    const { req, res, next } = mockReqRes({ country: 'ng', service: 'telegram' });

    await numberController.getPrice(req, res, next);

    expect(provider.resolveCountryId).toHaveBeenCalledWith('NG');
    expect(provider.resolveServiceId).toHaveBeenCalledWith('Telegram');
    expect(provider.getServicePrice).toHaveBeenCalledWith(159, '69c05c2e27c5759c68a8135e', 'server1');
    expect(next).not.toHaveBeenCalled();
    // 1560 * priceMarkup(1.4) = 2184 — NOT 1560 * 1.4 * 1600 (₦3,494,400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ userPrice: 2184, providerCost: 1560, inStock: true }));
  });

  test('a null cost (provider had nothing to quote) is a 404, not a crash', async () => {
    getProvider.mockReturnValue(fakeProvider({ getServicePrice: jest.fn().mockResolvedValue({ cost: null, inStock: false, server: 'server1' }) }));
    const { req, res, next } = mockReqRes({ country: 'NG', service: 'telegram' });
    await numberController.getPrice(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});

describe('buyNumber', () => {
  test('rejects an invalid serviceType', async () => {
    getProvider.mockReturnValue(fakeProvider());
    const { req, res, next } = mockReqRes({}, { serviceType: 'carrier-pigeon', country: 'NG' });
    await numberController.buyNumber(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  test('rejects an sms service with no real equivalent, before calling the provider at all', async () => {
    const provider = fakeProvider();
    getProvider.mockReturnValue(provider);
    const { req, res, next } = mockReqRes({}, { serviceType: 'sms', country: 'NG', service: 'twitter' });
    await numberController.buyNumber(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(provider.resolveCountryId).not.toHaveBeenCalled();
  });

  // The WhatsApp tab has no service dropdown at all — it must always
  // resolve to the real "Whatsapp" service regardless of what (if
  // anything) happens to be in the request body's `service` field.
  test('serviceType "whatsapp" always resolves to the Whatsapp service, ignoring body.service', async () => {
    const provider = fakeProvider();
    getProvider.mockReturnValue(provider);
    supabase.from.mockReturnValue({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({
        data: { id: 'o1', order_id: 'NV1', phone_number: '+234...', country: 'NG', service_type: 'whatsapp', service: 'whatsapp', user_cost: 2184, status: 'active', expires_at: new Date().toISOString() },
        error: null
      }) }) })
    });
    wallet.debitWallet.mockResolvedValue({});

    const { req, res, next } = mockReqRes({}, { serviceType: 'whatsapp', country: 'NG', service: 'ignored-value' });
    await numberController.buyNumber(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(provider.resolveServiceId).toHaveBeenCalledWith('Whatsapp');
  });

  test('an out-of-stock combo is rejected before any wallet debit or purchase attempt', async () => {
    const provider = fakeProvider({ getServicePrice: jest.fn().mockResolvedValue({ cost: 1560, inStock: false, server: 'server1' }) });
    getProvider.mockReturnValue(provider);
    const { req, res, next } = mockReqRes({}, { serviceType: 'sms', country: 'NG', service: 'telegram' });

    await numberController.buyNumber(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(provider.buyNumberForService).not.toHaveBeenCalled();
    expect(wallet.debitWallet).not.toHaveBeenCalled();
  });

  test('insufficient balance is checked against the correct NGN-only price, not the USD*ngnRate one', async () => {
    // real cost*markup = 2184; a wallet with 2000 must be rejected, not
    // silently accepted because of a wrong (much larger or smaller) number
    const provider = fakeProvider({ getServicePrice: jest.fn().mockResolvedValue({ cost: 1560, inStock: true, server: 'server1' }) });
    getProvider.mockReturnValue(provider);
    const { req, res, next } = mockReqRes({}, { serviceType: 'sms', country: 'NG', service: 'telegram' }, { id: 'u1', walletBalance: 2000 });

    await numberController.buyNumber(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(provider.buyNumberForService).not.toHaveBeenCalled();
  });

  test('happy path: correct provider calls, correct order payload, wallet debited for the real NGN price', async () => {
    const provider = fakeProvider();
    getProvider.mockReturnValue(provider);

    let insertedRow;
    supabase.from.mockReturnValue({
      insert: (row) => {
        insertedRow = row;
        return { select: () => ({ single: () => Promise.resolve({
          data: {
            id: 'o1', order_id: row.order_id, phone_number: row.phone_number, country: row.country,
            service_type: row.service_type, service: row.service, user_cost: row.user_cost,
            status: row.status, expires_at: row.expires_at
          },
          error: null
        }) }) };
      }
    });
    wallet.debitWallet.mockResolvedValue({});

    const { req, res, next } = mockReqRes({}, { serviceType: 'sms', country: 'ng', service: 'telegram' });
    await numberController.buyNumber(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(provider.resolveCountryId).toHaveBeenCalledWith('NG');
    expect(provider.resolveServiceId).toHaveBeenCalledWith('Telegram');
    expect(provider.buyNumberForService).toHaveBeenCalledWith(159, '69c05c2e27c5759c68a8135e', 'server1');

    // provider_cost is the raw provider number (1560); user_cost is that
    // run through the NGN-only formula (1560 * 1.4 = 2184) — the exact
    // distinction the currency bug collapsed.
    expect(insertedRow.provider_cost).toBe(1560);
    expect(insertedRow.user_cost).toBe(2184);
    expect(wallet.debitWallet).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', amount: 2184 }));

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      order: expect.objectContaining({ cost: 2184, phoneNumber: '+2348012345678' })
    }));
  });
});
