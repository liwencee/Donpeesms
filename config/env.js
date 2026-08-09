/**
 * Environment variable loader & validator
 */
require('dotenv').config();

// IMPORTANT: never process.exit() on a missing var. This process serves
// BOTH the frontend and the API, so exiting takes the whole site down —
// which is exactly what happened on Hostinger when one required var was
// missing. Instead we warn loudly and fall back so the app always boots:
// Supabase vars can't be faked — DB/auth features fail per-request, but
// the frontend and non-DB routes still serve.
const warnings = [];

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  warnings.push('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing — database features will fail until they are set.');
}

if (warnings.length) {
  console.warn('\n⚠️  Startup env warnings:\n   - ' + warnings.join('\n   - ') + '\n   (site still starts; frontend stays up)\n');
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,
  appName: process.env.APP_NAME || 'DonPeeSMS',
  // MAINTENANCE_MODE=true serves a maintenance page to visitors and
  // 503s the API, while /admin, admin auth, /health and static assets
  // stay reachable. Toggle back with MAINTENANCE_MODE=false (or unset).
  maintenance: process.env.MAINTENANCE_MODE === 'true',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  backendUrl:  process.env.BACKEND_URL  || 'http://localhost:5000',

  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,

  cookieSecret: process.env.COOKIE_SECRET || 'fallback-cookie-secret',

  smtp: {
    host:      process.env.SMTP_HOST,
    port:      parseInt(process.env.SMTP_PORT, 10) || 587,
    user:      process.env.SMTP_USER,
    pass:      process.env.SMTP_PASS,
    fromName:  process.env.SMTP_FROM_NAME  || 'DonPeeSMS',
    fromEmail: process.env.SMTP_FROM_EMAIL
  },

  sms: {
    provider: process.env.SMS_PROVIDER || 'sureverifications',
    fivesim: {
      apiKey:  process.env.FIVESIM_API_KEY,
      baseUrl: process.env.FIVESIM_BASE_URL || 'https://5sim.net/v1'
    },
    smsActivate: {
      apiKey:  process.env.SMSACTIVATE_API_KEY,
      baseUrl: process.env.SMSACTIVATE_BASE_URL
    },
    twilio: {
      sid:   process.env.TWILIO_ACCOUNT_SID,
      token: process.env.TWILIO_AUTH_TOKEN,
      from:  process.env.TWILIO_FROM_NUMBER
    },
    sureVerifications: {
      apiKey:  process.env.SURE_VERIFICATIONS_API_KEY || '',
      baseUrl: process.env.SURE_VERIFICATIONS_BASE_URL || 'https://sureverifications.com/api/v1'
    }
  },

  drexpay: {
    secretKey:     process.env.DREXPAY_SECRET_KEY,
    webhookSecret: process.env.DREXPAY_WEBHOOK_SECRET
  },

  priceMarkup: parseFloat(process.env.PRICE_MARKUP) || 1.4,

  ngnRate: parseFloat(process.env.NGN_RATE) || 1600,

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max:      parseInt(process.env.RATE_LIMIT_MAX, 10)        || 100,
    authMax:  parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10)   || 5
  },

  logLevel: process.env.LOG_LEVEL || 'info'
};
