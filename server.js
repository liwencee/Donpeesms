/**
 * DonPeeSMS Backend — Main Entry Point
 * Express + PostgreSQL (Prisma) + JWT + Stripe + NowPayments + PayPal + SMS providers
 */
// override:true makes the .env FILE authoritative over any stale
// environment variables set at the host/panel level (e.g. a wrong
// DATABASE_URL stuck in Hostinger's env panel). PORT is deliberately
// kept from the host (deleted from the file) so the LiteSpeed proxy
// still finds the app.
const _hostPort = process.env.PORT;
require('dotenv').config({ override: true });
if (_hostPort) process.env.PORT = _hostPort;

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const hpp          = require('hpp');

const env           = require('./config/env');
const { connectDB } = require('./config/db');
const { prisma }    = require('./config/db');
const logger        = require('./utils/logger');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { globalLimiter }          = require('./middleware/rateLimiter');

const authRoutes         = require('./routes/authRoutes');
const walletRoutes       = require('./routes/walletRoutes');
const numberRoutesModule = require('./routes/numberRoutes');
const numberRoutes       = numberRoutesModule;
const apiV1Numbers       = numberRoutesModule.apiRouter;
const userRoutes         = require('./routes/userRoutes');
const paymentRoutes      = require('./routes/paymentRoutes');

const app = express();

// ── TRUST PROXY (for IP behind nginx/cloudflare) ──
app.set('trust proxy', 1);

// ══════════════════════════════════════════
// SECURITY MIDDLEWARE
// ══════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy:      env.env === 'production',
  crossOriginEmbedderPolicy:  false
}));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = [
      env.frontendUrl,
      'http://localhost:5173',
      'http://localhost:3000',
      'https://donpeesms.com',
      'https://www.donpeesms.com',
      'https://donpeesms.netlify.app',
      'https://comforting-hotteok-f88aff.netlify.app'
    ];
    if (allowed.includes(origin) || env.env === 'development') return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']
}));

// ══════════════════════════════════════════
// WEBHOOKS — MUST USE RAW BODY (before json parser)
// ══════════════════════════════════════════
app.use('/api/payments', paymentRoutes);

// ══════════════════════════════════════════
// BODY PARSERS
// ══════════════════════════════════════════
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser(env.cookieSecret));

// ══════════════════════════════════════════
// MISC PROTECTION
// ══════════════════════════════════════════
app.use(hpp());

// ══════════════════════════════════════════
// LOGGING + COMPRESSION
// ══════════════════════════════════════════
if (env.env !== 'test') {
  app.use(morgan(env.env === 'production' ? 'combined' : 'dev', {
    stream: { write: (msg) => logger.http ? logger.http(msg.trim()) : logger.info(msg.trim()) }
  }));
}
app.use(compression());

// ══════════════════════════════════════════
// RATE LIMITING
// ══════════════════════════════════════════
app.use('/api', globalLimiter);

// ══════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    app:       env.appName,
    env:       env.env,
    uptime:    process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// DB diagnostic — pings the database with a short timeout so failures
// surface as a readable error instead of hanging the request.
app.get('/api/dbcheck', async (_req, res) => {
  const { prisma } = require('./config/db');
  const raw = process.env.DATABASE_URL || '';
  // Mask password between ':' and '@' so we can safely show the URL shape.
  const redacted = raw.replace(/:\/\/([^:]+):([^@]*)@/, '://$1:****@');
  const portMatch = raw.match(/@[^/:]+:(\d+)/);
  const info = {
    hasEnv: !!raw,
    envLen: raw.length,
    port: portMatch ? portMatch[1] : 'none',
    redacted: redacted.slice(0, 140)
  };
  const started = Date.now();
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error('DB query timed out after 8s')), 8000))
    ]);
    res.json({ ok: true, ...info, latencyMs: Date.now() - started });
  } catch (err) {
    res.status(503).json({ ok: false, ...info, latencyMs: Date.now() - started, error: err.message });
  }
});

app.get('/api', (_req, res) => {
  res.json({
    name:      env.appName + ' API',
    version:   '1.0.0',
    docs:      '/api/docs',
    health:    '/health',
    endpoints: ['/api/auth', '/api/wallet', '/api/numbers', '/api/users', '/api/payments', '/api/v1']
  });
});

// ══════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════
app.use('/api/auth',    authRoutes);
app.use('/api/wallet',  walletRoutes);
app.use('/api/numbers', numberRoutes);
app.use('/api/users',   userRoutes);
app.use('/api/v1',      apiV1Numbers);

// ══════════════════════════════════════════
// STATIC FRONTEND (DonPeeSMS SPA)
// ══════════════════════════════════════════
const path      = require('path');
const publicDir = path.join(__dirname, 'public');

app.use(express.static(publicDir, {
  maxAge:  env.env === 'production' ? '7d' : 0,
  etag:    true,
  index:   'index.html',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// SPA fallback
app.get(/^(?!\/api|\/health).*/, (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ══════════════════════════════════════════
// 404 + ERROR HANDLERS
// ══════════════════════════════════════════
app.use(notFound);
app.use(errorHandler);

// ══════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════
const start = async () => {
  await connectDB();

  const server = app.listen(env.port, () => {
    logger.info(`╔═══════════════════════════════════════════════╗`);
    logger.info(`║   ${env.appName} API running                       ║`);
    logger.info(`║   Env:  ${env.env.padEnd(37)} ║`);
    logger.info(`║   Port: ${String(env.port).padEnd(37)} ║`);
    logger.info(`║   URL:  http://localhost:${env.port}                ║`);
    logger.info(`╚═══════════════════════════════════════════════╝`);
  });

  startBackgroundJobs();

  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(() => {
      logger.info('HTTP server closed');
      require('./config/db').disconnectDB().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error('UNHANDLED REJECTION:', err));
  process.on('uncaughtException',  (err) => { logger.error('UNCAUGHT EXCEPTION:', err); shutdown('UNCAUGHT'); });
};

// ── Background jobs (poll expired orders) ────────────────────
const startBackgroundJobs = () => {
  const numberCtrl = require('./controllers/numberController');

  setInterval(async () => {
    try {
      const expired = await prisma.order.findMany({
        where: { status: 'active', expiresAt: { lt: new Date() } },
        take:  50
      });

      for (const order of expired) {
        const updatedOrder = await prisma.order.update({
          where: { id: order.id },
          data:  { status: 'expired' }
        });
        await numberCtrl._refundOrder(updatedOrder, 'No SMS received within window')
          .catch(err => logger.error(`Auto-refund failed for ${order.orderId}:`, err.message));
      }

      if (expired.length) logger.info(`Auto-expired ${expired.length} stale orders`);
    } catch (err) {
      logger.error('Background job error:', err.message);
    }
  }, 60_000);
};

if (require.main === module) {
  start();
}

module.exports = app;
