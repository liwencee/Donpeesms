/**
 * SMS Provider abstraction — unified interface over 5SIM, SMS-Activate, Twilio
 *
 * Methods:
 *   getPrice(country, service)
 *   buyNumber(country, service)
 *   checkOrder(providerOrderId)
 *   cancelOrder(providerOrderId)
 *   finishOrder(providerOrderId)
 */
const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');
const ApiError = require('../utils/apiError');

// ═════════════════════════════════════════════
// 5SIM Provider
// ═════════════════════════════════════════════
class FiveSimProvider {
  constructor() {
    this.name = 'fivesim';
    this.client = axios.create({
      baseURL: env.sms.fivesim.baseUrl,
      headers: {
        Authorization: `Bearer ${env.sms.fivesim.apiKey}`,
        Accept: 'application/json'
      },
      timeout: 15000
    });
  }

  async getBalance() {
    const { data } = await this.client.get('/user/profile');
    return { balance: data.balance, currency: 'RUB' };
  }

  async getPrice(country, service = 'any') {
    try {
      const { data } = await this.client.get(`/guest/prices`, { params: { country, product: service } });
      const countryData = data[country] || {};
      const serviceData = countryData[service] || Object.values(countryData)[0] || {};
      const operators = Object.values(serviceData);
      if (!operators.length) throw ApiError.notFound('No prices available for this combo');
      return { cost: operators[0].cost, count: operators[0].count, currency: 'RUB' };
    } catch (err) {
      logger.error('5sim getPrice:', err.message);
      throw ApiError.internal('Failed to fetch pricing');
    }
  }

  async buyNumber(country, service = 'any', operator = 'any') {
    try {
      const { data } = await this.client.get(`/user/buy/activation/${country}/${operator}/${service}`);
      return {
        providerOrderId: String(data.id),
        phoneNumber: data.phone,
        cost: data.price,
        expiresAt: new Date(data.expires),
        status: 'active'
      };
    } catch (err) {
      const msg = err.response?.data || err.message;
      logger.error('5sim buyNumber:', msg);
      if (String(msg).includes('no free')) throw ApiError.notFound('No numbers available for selected country/service');
      throw ApiError.internal('Failed to purchase number from provider');
    }
  }

  async checkOrder(providerOrderId) {
    const { data } = await this.client.get(`/user/check/${providerOrderId}`);
    return {
      status: this._mapStatus(data.status),
      sms: (data.sms || []).map(m => ({
        text: m.text,
        sender: m.sender,
        code: m.code,
        receivedAt: new Date(m.date)
      })),
      otpCode: data.sms?.[0]?.code || null
    };
  }

  async cancelOrder(providerOrderId) {
    await this.client.get(`/user/cancel/${providerOrderId}`);
    return { cancelled: true };
  }

  async finishOrder(providerOrderId) {
    await this.client.get(`/user/finish/${providerOrderId}`);
    return { finished: true };
  }

  _mapStatus(s) {
    const map = { PENDING: 'pending', RECEIVED: 'received', CANCELED: 'cancelled', TIMEOUT: 'expired', FINISHED: 'received', BANNED: 'failed' };
    return map[s] || 'pending';
  }
}

// ═════════════════════════════════════════════
// SMS-Activate Provider
// ═════════════════════════════════════════════
class SmsActivateProvider {
  constructor() {
    this.name = 'smsactivate';
    this.baseUrl = env.sms.smsActivate.baseUrl;
    this.apiKey = env.sms.smsActivate.apiKey;
  }

  async _call(action, extra = {}) {
    const params = new URLSearchParams({ api_key: this.apiKey, action, ...extra });
    const { data } = await axios.get(`${this.baseUrl}?${params}`, { timeout: 15000 });
    return data;
  }

  async getBalance() {
    const res = await this._call('getBalance');
    return { balance: parseFloat(String(res).split(':')[1] || '0'), currency: 'RUB' };
  }

  async getPrice(country, service = 'wa') {
    const res = await this._call('getPrices', { country, service });
    const parsed = typeof res === 'string' ? JSON.parse(res) : res;
    const data = parsed?.[country]?.[service] || {};
    return { cost: data.cost || 0, count: data.count || 0, currency: 'RUB' };
  }

  async buyNumber(country, service = 'wa') {
    const res = await this._call('getNumber', { country, service });
    if (String(res).startsWith('NO_NUMBERS')) throw ApiError.notFound('No numbers available');
    if (String(res).startsWith('ERROR')) throw ApiError.internal('Provider error: ' + res);
    const [, id, phone] = String(res).split(':');
    return {
      providerOrderId: id,
      phoneNumber: '+' + phone,
      cost: 0,
      expiresAt: new Date(Date.now() + 20 * 60 * 1000),
      status: 'active'
    };
  }

  async checkOrder(providerOrderId) {
    const res = await this._call('getStatus', { id: providerOrderId });
    const str = String(res);
    let status = 'pending', otp = null;
    if (str.startsWith('STATUS_OK')) { status = 'received'; otp = str.split(':')[1]; }
    else if (str.startsWith('STATUS_WAIT_RETRY')) status = 'pending';
    else if (str.startsWith('STATUS_CANCEL')) status = 'cancelled';
    return { status, sms: otp ? [{ code: otp, text: 'OTP: ' + otp, receivedAt: new Date() }] : [], otpCode: otp };
  }

  async cancelOrder(providerOrderId) {
    await this._call('setStatus', { id: providerOrderId, status: 8 });
    return { cancelled: true };
  }

  async finishOrder(providerOrderId) {
    await this._call('setStatus', { id: providerOrderId, status: 6 });
    return { finished: true };
  }
}

// ═════════════════════════════════════════════
// Twilio Provider (outbound only — for sending notifications)
// ═════════════════════════════════════════════
class TwilioProvider {
  constructor() {
    this.name = 'twilio';
  }

  async sendSMS(to, body) {
    if (!env.sms.twilio.sid) throw ApiError.internal('Twilio not configured');
    const auth = Buffer.from(`${env.sms.twilio.sid}:${env.sms.twilio.token}`).toString('base64');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.sms.twilio.sid}/Messages.json`;
    const params = new URLSearchParams({ To: to, From: env.sms.twilio.from, Body: body });
    const { data } = await axios.post(url, params, { headers: { Authorization: `Basic ${auth}` }, timeout: 10000 });
    return { sid: data.sid, status: data.status };
  }
}

// ═════════════════════════════════════════════
// SureVerifications Provider
// Docs: https://sureverifications.com/api/v1
// ═════════════════════════════════════════════
class SureVerificationsProvider {
  constructor() {
    this.name   = 'sureverifications';
    this.client = axios.create({
      baseURL: env.sms.sureVerifications.baseUrl,
      headers: {
        'x-api-key': env.sms.sureVerifications.apiKey,
        'Accept':    'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
  }

  // ── GET /api/v1/balance ──────────────────────
  async getBalance() {
    try {
      const { data } = await this.client.get('/balance');
      return {
        balance:  data.balance ?? data.data?.balance ?? 0,
        currency: data.currency ?? 'USD'
      };
    } catch (err) {
      logger.error('SureVerifications getBalance:', err.response?.data || err.message);
      throw ApiError.internal('Failed to fetch SureVerifications balance');
    }
  }

  // ── GET /api/v1/countries ────────────────────
  async getCountries() {
    try {
      const { data } = await this.client.get('/countries');
      return Array.isArray(data) ? data : (data.countries || data.data || []);
    } catch (err) {
      logger.error('SureVerifications getCountries:', err.response?.data || err.message);
      throw ApiError.internal('Failed to fetch countries');
    }
  }

  // ── GET /api/v1/server1/services ─────────────
  async getServices(server = 'server1') {
    try {
      const { data } = await this.client.get(`/${server}/services`);
      return Array.isArray(data) ? data : (data.services || data.data || []);
    } catch (err) {
      logger.error('SureVerifications getServices:', err.response?.data || err.message);
      throw ApiError.internal('Failed to fetch services');
    }
  }

  // ── GET /api/v1/server1/price?country=&service= ──
  async getPrice(country, service = 'whatsapp', server = 'server1') {
    try {
      const { data } = await this.client.get(`/${server}/price`, {
        params: { country: country.toLowerCase(), service: service.toLowerCase() }
      });
      const price = data.price ?? data.cost ?? data.data?.price ?? 0;
      const count = data.count ?? data.quantity ?? data.data?.count ?? 0;
      return { cost: parseFloat(price), count: parseInt(count, 10), currency: 'USD' };
    } catch (err) {
      // Fallback to server2 if server1 fails
      if (server === 'server1') {
        logger.warn('SureVerifications server1 price failed, trying server2');
        return this.getPrice(country, service, 'server2');
      }
      logger.error('SureVerifications getPrice:', err.response?.data || err.message);
      throw ApiError.notFound('Pricing unavailable for this country/service combo');
    }
  }

  // ── POST /api/v1/server1/purchase ───────────
  async buyNumber(country, service = 'whatsapp', server = 'server1') {
    try {
      const { data } = await this.client.post(`/${server}/purchase`, {
        country: country.toLowerCase(),
        service: service.toLowerCase()
      });
      const orderId = data.id ?? data.order_id ?? data.data?.id;
      const phone   = data.phone ?? data.number ?? data.data?.phone;
      const cost    = data.price ?? data.cost ?? data.data?.price ?? 0;
      if (!orderId || !phone) throw new Error('Invalid purchase response from provider');
      return {
        providerOrderId: String(orderId),
        phoneNumber:     phone.startsWith('+') ? phone : '+' + phone,
        cost:            parseFloat(cost),
        expiresAt:       new Date(Date.now() + 20 * 60 * 1000),
        status:          'active',
        server
      };
    } catch (err) {
      // Fallback to server2 if server1 has no numbers
      if (server === 'server1') {
        const errMsg = String(err.response?.data?.message || err.message).toLowerCase();
        if (errMsg.includes('no number') || errMsg.includes('not available') || errMsg.includes('out of stock')) {
          logger.warn(`SureVerifications server1 no numbers for ${country}/${service}, trying server2`);
          return this.buyNumber(country, service, 'server2');
        }
      }
      const msg = err.response?.data?.message || err.message;
      logger.error('SureVerifications buyNumber:', msg);
      if (String(msg).toLowerCase().includes('balance')) throw ApiError.badRequest('Insufficient provider balance');
      throw ApiError.notFound('No numbers available for selected country/service');
    }
  }

  // ── GET /api/v1/{server}/sms/{id} ───────────
  async checkOrder(providerOrderId, server = 'server1') {
    try {
      const { data } = await this.client.get(`/${server}/sms/${providerOrderId}`);
      const raw   = data.status ?? data.data?.status ?? 'pending';
      const smsList = data.sms ?? data.messages ?? data.data?.sms ?? [];
      const mapped = Array.isArray(smsList)
        ? smsList.map(m => ({
            text:       m.text || m.message || '',
            sender:     m.sender || m.from || '',
            code:       m.code || this._extractOtp(m.text || m.message || ''),
            receivedAt: m.created_at ? new Date(m.created_at) : new Date()
          }))
        : [];
      return {
        status:   this._mapStatus(raw),
        sms:      mapped,
        otpCode:  mapped[0]?.code || null
      };
    } catch (err) {
      logger.error('SureVerifications checkOrder:', err.response?.data || err.message);
      return { status: 'pending', sms: [], otpCode: null };
    }
  }

  // ── GET /api/v1/{server}/cancel/{id} ────────
  async cancelOrder(providerOrderId, server = 'server1') {
    try {
      await this.client.get(`/${server}/cancel/${providerOrderId}`);
      return { cancelled: true };
    } catch (err) {
      logger.warn('SureVerifications cancelOrder:', err.response?.data || err.message);
      return { cancelled: false };
    }
  }

  // ── GET /api/v1/{server}/finish/{id} ────────
  async finishOrder(providerOrderId, server = 'server1') {
    try {
      await this.client.get(`/${server}/finish/${providerOrderId}`);
      return { finished: true };
    } catch (err) {
      logger.warn('SureVerifications finishOrder:', err.response?.data || err.message);
      return { finished: false };
    }
  }

  _mapStatus(s) {
    const map = {
      pending:   'pending', waiting: 'pending', active:    'pending',
      received:  'received', success: 'received', completed: 'received',
      cancelled: 'cancelled', canceled: 'cancelled',
      expired:   'expired',  timeout:  'expired',
      failed:    'failed',   error:    'failed'
    };
    return map[String(s).toLowerCase()] || 'pending';
  }

  _extractOtp(text) {
    const match = text.match(/\b\d{4,8}\b/);
    return match ? match[0] : null;
  }
}

// ═════════════════════════════════════════════
// Provider Factory
// ═════════════════════════════════════════════
const providers = {};

const getProvider = (name = env.sms.provider) => {
  if (providers[name]) return providers[name];

  switch (name) {
    case 'fivesim':           providers[name] = new FiveSimProvider(); break;
    case 'smsactivate':       providers[name] = new SmsActivateProvider(); break;
    case 'twilio':            providers[name] = new TwilioProvider(); break;
    case 'sureverifications': providers[name] = new SureVerificationsProvider(); break;
    default: throw ApiError.internal(`Unknown SMS provider: ${name}`);
  }
  return providers[name];
};

const calculateUserPrice = (providerCost) =>
  Math.round((providerCost * env.priceMarkup) * 100) / 100;

module.exports = { getProvider, calculateUserPrice, FiveSimProvider, SmsActivateProvider, TwilioProvider, SureVerificationsProvider };
