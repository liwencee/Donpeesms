/**
 * DonPeeSMS Backend — Main Entry Point
 * Express + Supabase (Postgres + Auth) + DrexPay + SMS providers
 */
// Load config from a .env file placed NEXT TO this file (__dirname), and
// let it override any stale/broken values from the host's env panel.
// This lets you configure the app by uploading a .env file via File
// Manager, bypassing Hostinger's Environment Variables panel entirely
// (which has a bug that drops saved values). PORT is kept from the host
// so the LiteSpeed/Passenger proxy still finds the app.
//
// EXCEPTION — tests: the override is disabled when NODE_ENV=test. The
// worktree's .env carries NODE_ENV=production and real Supabase
// credentials, so an unconditional override would clobber the dummy
// values tests/setup.js installs, flip NODE_ENV away from 'test', and
// make start() bind a port and register the 60-second auto-expire /
// auto-refund job — pointed at the live project — during `npm test`.
const _hostPort = process.env.PORT;
require('dotenv').config({
  path: require('path').join(__dirname, '.env'),
  override: process.env.NODE_ENV !== 'test'
});
if (_hostPort) process.env.PORT = _hostPort;

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const hpp          = require('hpp');

const env           = require('./config/env');
const { supabase }  = require('./config/supabase');
const logger        = require('./utils/logger');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { globalLimiter }          = require('./middleware/rateLimiter');

const { protect, requireRole } = require('./middleware/auth');
const walletRoutes       = require('./routes/walletRoutes');
const numberRoutesModule = require('./routes/numberRoutes');
const numberRoutes       = numberRoutesModule;
const apiV1Numbers       = numberRoutesModule.apiRouter;
const userRoutes         = require('./routes/userRoutes');
const paymentRoutes      = require('./routes/paymentRoutes');
const productRoutes      = require('./routes/productRoutes');
const adminRoutes        = require('./routes/adminRoutes');
const apiProviderRoutes  = require('./routes/apiProviderRoutes');

const app = express();

// ── TRUST PROXY (for IP behind nginx/cloudflare) ──
app.set('trust proxy', 1);

// ══════════════════════════════════════════
// SECURITY MIDDLEWARE
// ══════════════════════════════════════════
app.use(helmet({
  // This app's UI relies throughout on inline onclick="" attributes (180+
  // in public/index.html — tab switches, password toggles, social buttons,
  // notifications, modals). Helmet's default CSP directives include
  // script-src-attr 'none', which silently blocks every one of them —
  // discovered when NODE_ENV=production made this activate for the first
  // time and the entire site's click interactivity stopped working.
  // script-src itself stays 'self' only, so externally injected <script>
  // tags are still blocked; this only permits the attribute-handler
  // pattern the app already depends on everywhere.
  contentSecurityPolicy: env.env === 'production' ? {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src-attr': ["'unsafe-inline'"],
      // connect-src has no override in the defaults above, so it falls
      // back to default-src 'self' — which silently blocks every fetch()
      // the browser makes to Supabase's own API (a different origin).
      // Every Supabase Auth call (signUp, signInWithPassword, etc.) failed
      // with a bare "Failed to fetch" until this was added.
      'connect-src': ["'self'", env.supabaseUrl]
    }
  } : false,
  crossOriginEmbedderPolicy:  false
}));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = [
      env.frontendUrl,
      'http://localhost:5173',
      'http://localhost:3000',
      // The app's own default port (config/env.js) — server.js serves the
      // SPA itself here, so same-origin PATCH/POST/DELETE calls from a
      // browser at this address carry an Origin header (unlike simple
      // GETs, which browsers often omit it for) and were being rejected.
      'http://localhost:5000',
      'https://donpeesms.com',
      'https://www.donpeesms.com',
      'https://donpeesms.netlify.app',
      'https://comforting-hotteok-f88aff.netlify.app'
    ];
    // Allow the Railway-provided domains (e.g. *.up.railway.app) so the
    // app works when accessed via its Railway URL before the custom
    // domain is attached.
    const isRailway = /\.(up\.)?railway\.app$/i.test(new URL(origin).hostname);
    if (allowed.includes(origin) || isRailway || env.env === 'development') return cb(null, true);
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
// Admin-only: this previously leaked DB host/port details and, during a
// prior incident, raw engine stack traces to anyone on the internet.
app.get('/api/dbcheck', protect, requireRole('admin'), async (_req, res) => {
  const started = Date.now();
  try {
    const { error } = await supabase.from('categories').select('id').limit(1);
    if (error) throw error;
    res.json({ ok: true, latencyMs: Date.now() - started });
  } catch (err) {
    res.status(503).json({ ok: false, latencyMs: Date.now() - started, error: err.message });
  }
});

app.get('/api', (_req, res) => {
  res.json({
    name:      env.appName + ' API',
    version:   '1.0.0',
    docs:      '/api/docs',
    health:    '/health',
    endpoints: ['/api/wallet', '/api/numbers', '/api/users', '/api/payments', '/api/v1']
  });
});

// ══════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════
app.use('/api/wallet',  walletRoutes);
app.use('/api/numbers', numberRoutes);
app.use('/api/users',   userRoutes);
app.use('/api/v1',      apiV1Numbers);
app.use('/api/products', productRoutes.publicRouter);  // public catalog
app.use('/api/admin',    productRoutes.adminRouter);    // admin product/category CRUD
app.use('/api/admin',    adminRoutes);                  // admin users/orders
app.use('/api/admin/api-providers', apiProviderRoutes); // admin API provider CRUD

// ══════════════════════════════════════════
// STATIC FRONTEND (DonPeeSMS SPA)
// ══════════════════════════════════════════
const path      = require('path');
const publicDir = path.join(__dirname, 'public');

// Ahead of express.static: otherwise "/" is answered by its index:
// 'index.html' option before the gate ever runs.
app.use(require('./middleware/frontendMaintenance'));

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
  // Awaited so the first requests after a deploy reflect the real flag
  // rather than the module's default. It re-reads on a TTL after this,
  // so a value changed in the database still lands without a restart.
  await require('./utils/maintenanceFlag').load();

  // Warm SureVerifications' service-id cache in the background — not
  // awaited, so it never delays app.listen(). resolveServiceId's cache
  // is empty on every fresh process (every deploy restarts it), and
  // filling it costs a real ~2-5s of provider calls even after
  // parallelizing (was 17-30s sequential) — enough to blow the
  // frontend's request timeout if the first real customer buy is what
  // triggers it instead of this.
  if (env.sms.provider === 'sureverifications') {
    require('./services/smsProvider').getProvider('sureverifications')
      .resolveServiceId('Whatsapp')
      .then(() => logger.info('SureVerifications service cache warmed'))
      .catch(err => logger.warn('SureVerifications cache warm-up failed (will retry on first real request):', err.message));
  }

  const server = app.listen(env.port, () => {
    logger.info(`╔═══════════════════════════════════════════════╗`);
    logger.info(`║   ${env.appName} API running                       ║`);
    logger.info(`║   Env:  ${env.env.padEnd(37)} ║`);
    logger.info(`║   Port: ${String(env.port).padEnd(37)} ║`);
    logger.info(`║   URL:  http://localhost:${env.port}                ║`);
    logger.info(`╚═══════════════════════════════════════════════╝`);
  });

  server.on('error', (err) => {
    logger.error(`HTTP server failed to bind on port ${env.port}: ${err.code || err.message}`);
  });

  startBackgroundJobs();

  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Log and KEEP RUNNING. Previously an uncaughtException triggered a
  // full shutdown, so a single unexpected error in one request took the
  // entire site down for everyone — and since production runs bare
  // `node server.js` with no process manager, it stayed down until the
  // host happened to restart it. That is the most likely cause of the
  // intermittent blank-500s with nothing in the runtime logs.
  //
  // Express already isolates per-request errors (asyncHandler ->
  // errorHandler), so anything reaching here is from outside the request
  // cycle (a stray timer/callback). Staying alive is strictly safer than
  // dropping every in-flight request and going offline.
  process.on('unhandledRejection', (err) => {
    logger.error('UNHANDLED REJECTION (server continuing):', err && err.stack ? err.stack : err);
  });
  process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION (server continuing):', err && err.stack ? err.stack : err);
  });
};

// ── Background jobs (poll expired orders) ────────────────────
const startBackgroundJobs = () => {
  const numberCtrl = require('./controllers/numberController');
  const { toCamelCase } = require('./utils/caseMapper');

  setInterval(async () => {
    try {
      const { data: expired, error } = await supabase
        .from('orders')
        .select('*')
        .eq('status', 'active')
        .lt('expires_at', new Date().toISOString())
        .limit(50);
      if (error) throw error;

      for (const orderRow of expired) {
        // `.eq('status', 'active')` turns this into a claim: a user
        // polling GET /orders/:id/status runs the identical transition,
        // and exactly one of the two may win. No row back means the
        // other path already expired and refunded it — skip, don't crash.
        const { data: updatedRow, error: updateErr } = await supabase
          .from('orders').update({ status: 'expired' })
          .eq('id', orderRow.id).eq('status', 'active')
          .select().maybeSingle();
        if (updateErr) { logger.error('Auto-expire update failed:', updateErr.message); continue; }
        if (!updatedRow) continue;

        await numberCtrl._refundOrder(toCamelCase(updatedRow), 'No SMS received within window')
          .catch(err => logger.error(`Auto-refund failed for ${orderRow.order_id}:`, err.stack || err.message));
      }

      if (expired.length) logger.info(`Auto-expired ${expired.length} stale orders`);
    } catch (err) {
      logger.error('Background job error:', err.stack || err.message);
    }
  }, 60_000);
};

// Always start the server. Hostinger/LiteSpeed may load this file via
// require() rather than running it directly, in which case
// `require.main === module` is false and the old guard skipped start()
// entirely — the process stayed up but never called app.listen(), so
// nothing (not even static files) responded. Starting unconditionally
// guarantees the app binds its port.
//
// The one exception is tests: they import `app` to make requests via
// supertest and must not bind a port or spin up the background job
// (that would leave open handles and hang the test run).
if (process.env.NODE_ENV !== 'test') {
  start();
}

module.exports = app;
