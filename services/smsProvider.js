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
// Provider Factory
// ═════════════════════════════════════════════
const providers = {};

const getProvider = (name = env.sms.provider) => {
  if (providers[name]) return providers[name];

  switch (name) {
    case 'fivesim':     providers[name] = new FiveSimProvider(); break;
    case 'smsactivate': providers[name] = new SmsActivateProvider(); break;
    case 'twilio':      providers[name] = new TwilioProvider(); break;
    default: throw ApiError.internal(`Unknown SMS provider: ${name}`);
  }
  return providers[name];
};

const calculateUserPrice = (providerCost) =>
  Math.round((providerCost * env.priceMarkup) * 100) / 100;

module.exports = { getProvider, calculateUserPrice, FiveSimProvider, SmsActivateProvider, TwilioProvider };
