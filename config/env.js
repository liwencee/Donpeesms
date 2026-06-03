/**
 * Environment variable loader & validator
 */
require('dotenv').config();

const required = [
  'NODE_ENV', 'PORT', 'DATABASE_URL',
  'JWT_SECRET', 'JWT_REFRESH_SECRET'
];

const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌ Missing required env vars: ${missing.join(', ')}\n`);
  process.exit(1);
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,
  appName: process.env.APP_NAME || 'DonPeeSMS',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  backendUrl:  process.env.BACKEND_URL  || 'http://localhost:5000',

  databaseUrl: process.env.DATABASE_URL,

  jwt: {
    secret:           process.env.JWT_SECRET,
    expiresIn:        process.env.JWT_EXPIRES_IN        || '7d',
    refreshSecret:    process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d'
  },

  cookieSecret: process.env.COOKIE_SECRET || 'fallback-cookie-secret',
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,

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

  stripe: {
    secret:        process.env.STRIPE_SECRET_KEY,
    publishable:   process.env.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET
  },

  nowPayments: {
    apiKey:    process.env.NOWPAYMENTS_API_KEY,
    ipnSecret: process.env.NOWPAYMENTS_IPN_SECRET,
    baseUrl:   process.env.NOWPAYMENTS_BASE_URL || 'https://api.nowpayments.io/v1'
  },

  paypal: {
    clientId:     process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    mode:         process.env.PAYPAL_MODE || 'sandbox'
  },

  priceMarkup: parseFloat(process.env.PRICE_MARKUP) || 1.4,

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max:      parseInt(process.env.RATE_LIMIT_MAX, 10)        || 100,
    authMax:  parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10)   || 5
  },

  logLevel: process.env.LOG_LEVEL || 'info'
};
