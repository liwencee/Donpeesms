# DonPeeSMS Backend

Production-ready Node.js backend for **DonPeeSMS** — an international WhatsApp & SMS virtual number marketplace with a wallet system.

## Stack

- **Runtime:** Node.js 18+
- **Framework:** Express 4
- **Database:** MongoDB (Mongoose)
- **Auth:** JWT (access + refresh) + bcrypt + TOTP 2FA
- **Payments:** Stripe (cards) · NowPayments (crypto) · PayPal
- **SMS Providers:** 5SIM · SMS-Activate · Twilio
- **Email:** Nodemailer (SMTP)
- **Security:** helmet, express-rate-limit, mongo-sanitize, hpp, CORS

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your real keys

# 3. Make sure MongoDB is running
# Local: mongod
# Or use MongoDB Atlas (set MONGO_URI)

# 4. Seed database (optional)
npm run seed

# 5. Start
npm run dev    # development with auto-reload
npm start      # production
```

Server runs at `http://localhost:5000`.

## Architecture

```
fintect/
├── server.js                  # Entry point
├── config/
│   ├── env.js                 # Env validation & loading
│   └── db.js                  # MongoDB connection
├── models/
│   ├── User.js                # Auth, profile, 2FA, wallet ref
│   ├── Transaction.js         # All wallet flows
│   ├── Order.js               # Number purchases
│   └── ApiKey.js              # Developer API keys
├── controllers/
│   ├── authController.js      # Register, login, 2FA, password reset
│   ├── walletController.js    # Balance, top-up, debit/credit
│   ├── numberController.js    # Buy, check, cancel numbers
│   └── userController.js      # Profile, API keys, referrals
├── routes/
│   ├── authRoutes.js
│   ├── walletRoutes.js
│   ├── numberRoutes.js
│   ├── userRoutes.js
│   └── paymentRoutes.js       # Webhooks + PayPal capture
├── services/
│   ├── smsProvider.js         # 5SIM + SMS-Activate + Twilio
│   ├── stripeService.js       # Stripe Checkout + Payment Intents
│   ├── nowPaymentsService.js  # Crypto payments
│   ├── paypalService.js       # PayPal orders + capture
│   ├── emailService.js        # Branded HTML emails
│   └── totpService.js         # TOTP 2FA + backup codes
├── middleware/
│   ├── auth.js                # JWT + API key auth + role guards
│   ├── errorHandler.js        # Centralized error handling
│   ├── rateLimiter.js         # Global + auth + purchase limits
│   └── validate.js            # Validation wrapper
├── webhooks/
│   ├── stripeWebhook.js
│   ├── nowPaymentsWebhook.js
│   └── paypalWebhook.js
└── utils/
    ├── logger.js              # Winston structured logs
    ├── jwt.js                 # Sign/verify tokens
    ├── apiError.js            # Operational errors
    ├── asyncHandler.js
    └── seed.js                # DB seeder
```

## API Endpoints

### Authentication

| Method | Endpoint                          | Description                  |
|--------|-----------------------------------|------------------------------|
| POST   | `/api/auth/register`              | Create account               |
| POST   | `/api/auth/login`                 | Login (returns JWT)          |
| POST   | `/api/auth/refresh`               | Refresh access token         |
| POST   | `/api/auth/logout`                | Clear cookies                |
| GET    | `/api/auth/me`                    | Current user                 |
| POST   | `/api/auth/verify-email`          | Verify with token            |
| POST   | `/api/auth/resend-verification`   | Resend verify email          |
| POST   | `/api/auth/forgot-password`       | Send reset link              |
| POST   | `/api/auth/reset-password`        | Reset with token             |
| POST   | `/api/auth/change-password`       | Authenticated change         |
| POST   | `/api/auth/2fa/setup`             | Get QR + secret              |
| POST   | `/api/auth/2fa/verify`            | Confirm + enable             |
| POST   | `/api/auth/2fa/disable`           | Disable (password required)  |

### Wallet

| Method | Endpoint                          | Description                  |
|--------|-----------------------------------|------------------------------|
| GET    | `/api/wallet`                     | Current balance              |
| POST   | `/api/wallet/topup`               | Initiate top-up              |
| GET    | `/api/wallet/transactions`        | List transactions (paged)    |
| GET    | `/api/wallet/transactions/:id`    | Get transaction              |

### Numbers

| Method | Endpoint                                | Description              |
|--------|-----------------------------------------|--------------------------|
| GET    | `/api/numbers/countries`                | List countries           |
| GET    | `/api/numbers/services`                 | List services            |
| GET    | `/api/numbers/price?country=&service=`  | Get current price        |
| POST   | `/api/numbers/buy`                      | Buy number               |
| GET    | `/api/numbers/orders`                   | List user orders         |
| GET    | `/api/numbers/orders/:id`               | Get order                |
| GET    | `/api/numbers/orders/:id/status`        | Poll for OTP             |
| POST   | `/api/numbers/orders/:id/cancel`        | Cancel + auto-refund     |

### Users

| Method | Endpoint                          | Description                  |
|--------|-----------------------------------|------------------------------|
| GET    | `/api/users/me`                   | Profile                      |
| PATCH  | `/api/users/me`                   | Update profile               |
| DELETE | `/api/users/me`                   | Delete account               |
| GET    | `/api/users/dashboard-stats`      | Stats for dashboard          |
| GET    | `/api/users/api-keys`             | List API keys                |
| POST   | `/api/users/api-keys`             | Create new key (shown once)  |
| DELETE | `/api/users/api-keys/:id`         | Revoke                       |
| GET    | `/api/users/referral`             | Referral stats               |

### Payments (Webhooks)

| Method | Endpoint                              | Description           |
|--------|---------------------------------------|-----------------------|
| POST   | `/api/payments/webhooks/stripe`       | Stripe events         |
| POST   | `/api/payments/webhooks/nowpayments`  | NowPayments IPN       |
| POST   | `/api/payments/webhooks/paypal`       | PayPal events         |
| POST   | `/api/payments/paypal/capture`        | Capture approved order|

### External Developer API (uses `x-api-key` header)

| Method | Endpoint                          | Description           |
|--------|-----------------------------------|-----------------------|
| GET    | `/api/v1/price`                   | Get price             |
| POST   | `/api/v1/numbers`                 | Buy number            |
| GET    | `/api/v1/numbers`                 | List orders           |
| GET    | `/api/v1/numbers/:id`             | Get order             |
| GET    | `/api/v1/numbers/:id/status`      | Check OTP             |
| POST   | `/api/v1/numbers/:id/cancel`      | Cancel                |

## Key Features

### Security
- **bcrypt** password hashing (configurable rounds, default 12)
- **JWT** access tokens (7d) + refresh tokens (30d) in httpOnly cookies
- **TOTP 2FA** with backup codes (speakeasy + QR code)
- **Account lockout** after 5 failed login attempts (30-min lock)
- **Email verification** required for purchases
- **Rate limiting** — global, auth, purchase, webhooks
- **CSRF protection** via SameSite cookies
- **MongoDB injection** prevention (mongo-sanitize)
- **HTTP Parameter Pollution** prevention (hpp)
- **Helmet** security headers

### Wallet & Transactions
- **MongoDB transactions** (atomic credit/debit) prevent race conditions
- **Bonus tiers**: $25+ (10%), $50+ (15%), $100+ (20%)
- **Referral program**: 10% commission on referred users' top-ups
- **Auto-refund** on expired numbers (no OTP received)
- **Welcome bonus**: $0.10 credit for new accounts

### Number Service
- **Multi-provider** abstraction — switch providers via env var
- **40% markup** on provider price (configurable)
- **Background job** polls expired orders every 60s, auto-refunds
- **Live OTP polling** via order status endpoint

### Payments
- **Stripe Checkout** for cards
- **NowPayments** for USDT/BTC/ETH/etc. (with IPN signature verification)
- **PayPal Orders v2** API (sandbox + live)
- **Webhook signature verification** for all providers

## Webhook Setup

### Stripe
```
Endpoint: https://your-domain.com/api/payments/webhooks/stripe
Events: checkout.session.completed, payment_intent.payment_failed, charge.refunded
```
Copy webhook signing secret to `STRIPE_WEBHOOK_SECRET`.

### NowPayments
```
IPN URL: https://your-domain.com/api/payments/webhooks/nowpayments
```
Set IPN secret in dashboard, copy to `NOWPAYMENTS_IPN_SECRET`.

### PayPal
```
Webhook URL: https://your-domain.com/api/payments/webhooks/paypal
Events: PAYMENT.CAPTURE.COMPLETED, CHECKOUT.ORDER.APPROVED
```

## Production Deployment

```bash
# Set production env vars
NODE_ENV=production
MONGO_URI=mongodb+srv://...
JWT_SECRET=<long random string>
# ...etc

# Use PM2 or similar
npm install -g pm2
pm2 start server.js --name donpeesms-api
pm2 startup
pm2 save
```

Behind nginx, expose only `/api/*` and `/health`. Set up SSL via Let's Encrypt.

## Default Credentials (after seed)

| Role  | Email                  | Password   |
|-------|------------------------|------------|
| Admin | admin@donpeesms.com      | Admin1234! |
| Demo  | demo@donpeesms.com       | Demo1234!  |

**Change these immediately in production.**

## License

Proprietary — All rights reserved.
