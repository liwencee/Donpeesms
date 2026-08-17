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
    // getProvider() memoizes one instance per process, so these persist
    // for the process lifetime — the country list and service catalog
    // rarely change, and refetching either live on every price check /
    // purchase would add a full extra round trip (250 countries, or a
    // per-variant price fetch per service) to every request.
    this._countryIdCache = null; // Map<iso2, numeric country_id>
    this._serviceIdCache = null; // Map<exact service name, opaque service id>
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

  // ── GET /api/v1/{server}/services?country_id= ──
  // The real endpoint contract: country_id is required (confirmed against
  // the live API — the plain getServices() above has never actually
  // worked). Returns [{id, name}] where id is an opaque provider id, NOT
  // a friendly slug — server1 ids are long hex-like strings and can repeat
  // the same name more than once (e.g. multiple "Whatsapp" entries); server2
  // ids are short codes (e.g. "am" for Amazon).
  async getServicesForCountry(countryId, server = 'server1') {
    try {
      const { data } = await this.client.get(`/${server}/services`, { params: { country_id: countryId } });
      return Array.isArray(data) ? data : (data.services || data.data || []);
    } catch (err) {
      logger.error('SureVerifications getServicesForCountry:', err.response?.data || err.message);
      throw ApiError.internal('Failed to fetch services for country');
    }
  }

  // ── GET /api/v1/{server}/price?country_id=&service= ──
  // service must be the opaque id from getServicesForCountry, not a name.
  // server1 returns a single price; server2 returns an array of tiers
  // (different sellers/batches at different prices) — normalized here to
  // the cheapest in-stock tier so callers get one consistent shape.
  async getServicePrice(countryId, serviceId, server = 'server1') {
    try {
      const { data } = await this.client.get(`/${server}/price`, {
        params: { country_id: countryId, service: serviceId }
      });
      if (server === 'server1') {
        const p = data.price;
        return { cost: parseFloat(p?.price ?? 0), inStock: p?.service?.stocks !== 0, server };
      }
      const tiers = (data.prices || []).filter(t => t.service?.stocks !== 0);
      if (!tiers.length) return { cost: null, inStock: false, server };
      const cheapest = tiers.reduce((a, b) => (b.price < a.price ? b : a));
      return { cost: parseFloat(cheapest.price), inStock: true, server };
    } catch (err) {
      logger.error('SureVerifications getServicePrice:', err.response?.data || err.message);
      return { cost: null, inStock: false, server };
    }
  }

  // Resolves a 2-letter code (as the frontend's country dropdowns already
  // send) to the numeric country_id every other real endpoint requires.
  // Cached per process — see the constructor comment.
  async resolveCountryId(iso2) {
    if (!this._countryIdCache) {
      const countries = await this.getCountries();
      this._countryIdCache = new Map();
      for (const c of countries) {
        if (c.data?.iso2) this._countryIdCache.set(c.data.iso2.toUpperCase(), c.id);
      }
    }
    const id = this._countryIdCache.get(String(iso2).toUpperCase());
    if (id == null) throw ApiError.badRequest(`Unknown country: ${iso2}`);
    return id;
  }

  // Resolves an exact SureVerifications service name (e.g. "Telegram",
  // "Whatsapp") to its opaque service id, using dedupeServicesByName's
  // cheapest-in-stock-variant pick for names the API lists more than once
  // (see that function's comment). Resolved once against Nigeria — service
  // identity is the same across countries (confirmed live: identical id
  // list for USA and Nigeria), only price/stock vary — and cached, so
  // this never repeats dedupeServicesByName's per-variant price fetches on
  // a normal request.
  async resolveServiceId(name) {
    if (!this._serviceIdCache) {
      const referenceCountryId = await this.resolveCountryId('NG');
      const catalog = await dedupeServicesByName(this, referenceCountryId, 'server1');
      this._serviceIdCache = new Map(catalog.map(item => [item.name, item.id]));
    }
    const id = this._serviceIdCache.get(name);
    if (!id) throw ApiError.badRequest(`"${name}" is not currently available`);
    return id;
  }

  // ── POST /api/v1/{server}/purchase ───────────
  // {country_id, service} confirmed live: a real request with no balance
  // gets a clean 402 "Insufficient wallet balance" — past all parameter
  // validation, i.e. the request shape itself is correct. The SUCCESS
  // shape below is not: this account has never had a balance to complete
  // a real purchase with, so the response field names are the same
  // flexible best-guess pattern as the rest of this file, unverified.
  async buyNumberForService(countryId, serviceId, server = 'server1') {
    try {
      const { data } = await this.client.post(`/${server}/purchase`, {
        country_id: countryId, service: serviceId
      });
      const providerOrderId = data.id ?? data.order_id ?? data.data?.id;
      const phone = data.phone ?? data.number ?? data.data?.phone;
      if (!providerOrderId || !phone) throw new Error('Malformed purchase response: ' + JSON.stringify(data));
      return {
        providerOrderId: String(providerOrderId),
        phoneNumber: String(phone).startsWith('+') ? phone : '+' + phone,
        cost: parseFloat(data.price ?? data.cost ?? data.data?.price ?? 0),
        expiresAt: new Date(Date.now() + 20 * 60 * 1000),
        server
      };
    } catch (err) {
      logger.error('SureVerifications buyNumberForService:', err.response?.data || err.message);
      if (err.response?.status === 402) throw ApiError.badRequest('Provider balance too low to fulfil this purchase — please contact support');
      throw ApiError.badRequest('No numbers available for this country/service right now');
    }
  }

  // ── GET /api/v1/{server}/sms/{id} ────────────
  // UNVERIFIED — 8 plausible path variations (this one, /order/{id},
  // /status/{id}, /check/{id}, /purchase/{id}, a query-param form, etc.)
  // all returned the same generic "route not found" for any id, live.
  // Left exactly as it was rather than guessing further: this account has
  // never completed a real purchase, so there's no real response to learn
  // the correct shape from. Needs either provider docs or one real funded
  // purchase to resolve.
  async checkOrder(providerOrderId, server = 'server1') {
    try {
      const { data } = await this.client.get(`/${server}/sms/${providerOrderId}`);
      const raw = data.status ?? data.data?.status ?? 'pending';
      const smsList = data.sms ?? data.messages ?? data.data?.sms ?? [];
      const messages = (Array.isArray(smsList) ? smsList : []).map(m => ({
        text: m.text ?? m.message ?? '', sender: m.sender ?? m.from ?? '',
        code: m.code ?? this._extractOtp(m.text ?? m.message ?? ''),
        receivedAt: m.created_at ? new Date(m.created_at) : new Date()
      }));
      return { status: this._mapStatus(raw), sms: messages, otpCode: messages[0]?.code || null };
    } catch (err) {
      logger.error('SureVerifications checkOrder:', err.response?.data || err.message);
      return { status: 'pending', sms: [], otpCode: null };
    }
  }

  // ── GET /api/v1/{server}/cancel/{id} ─────────
  async cancelOrder(providerOrderId, server = 'server1') {
    try {
      await this.client.get(`/${server}/cancel/${providerOrderId}`);
      return { cancelled: true };
    } catch (err) {
      logger.warn('SureVerifications cancelOrder:', err.response?.data || err.message);
      return { cancelled: false };
    }
  }

  // ── GET /api/v1/{server}/finish/{id} ─────────
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
    const match = String(text || '').match(/\b\d{4,8}\b/);
    return match ? match[0] : null;
  }
}

// Groups a provider's per-country service list by exact name and resolves
// each group to its cheapest in-stock variant (SureVerifications lists
// some names — e.g. "Whatsapp" — under several different opaque ids;
// confirmed live: 4 "Whatsapp"-family entries, 3 "Telegram" ones, on
// server1 alone). Used by SureVerificationsProvider's own resolveServiceId
// (the real number-purchase pipeline) and by numberController.listServices
// to populate the SMS-buy dropdown with real services.
const dedupeServicesByName = async (provider, countryId, server = 'server1') => {
  const services = await provider.getServicesForCountry(countryId, server);

  // Pricing every variant one at a time took 17-30s for ~50 services on
  // server1 (confirmed live) — long enough to blow past the frontend's
  // request timeout on the very first call after every process restart,
  // since resolveServiceId's cache is empty then. A small worker pool
  // gets the same total work done in a few seconds without firing 50
  // requests at the provider simultaneously.
  const CONCURRENCY = 8;
  const priced = new Array(services.length);
  let next = 0;
  const worker = async () => {
    while (next < services.length) {
      const i = next++;
      priced[i] = { ...services[i], price: await provider.getServicePrice(countryId, services[i].id, server) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, services.length) }, worker));

  const byName = {};
  for (const { id, name, price } of priced) (byName[name] ||= []).push({ id, price });

  const catalog = [];
  for (const [name, variants] of Object.entries(byName)) {
    let best = null;
    for (const { id, price } of variants) {
      if (price.cost == null) continue;
      const better = !best
        || (price.inStock && !best.inStock)
        || (price.inStock === best.inStock && price.cost < best.cost);
      if (better) best = { ...price, id, name };
    }
    if (best) catalog.push(best);
  }
  return catalog.sort((a, b) => a.name.localeCompare(b.name));
};

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
  Math.round(providerCost * env.priceMarkup * env.ngnRate);

// SureVerifications' raw cost is already NGN (confirmed against the
// account's own billing history) — unlike the other providers above,
// whose raw cost is USD, hence calculateUserPrice's extra ngnRate
// multiply. Only the markup applies; ngnRate again would inflate this
// 1600x (confirmed by the obviously-wrong number it produced: ₦3.49M
// for a single WhatsApp number).
const calculateSureVerificationsPrice = (rawCost) => Math.round(rawCost * env.priceMarkup);

module.exports = {
  getProvider, calculateUserPrice, calculateSureVerificationsPrice, dedupeServicesByName,
  FiveSimProvider, SmsActivateProvider, TwilioProvider, SureVerificationsProvider
};
