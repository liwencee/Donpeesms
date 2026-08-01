/**
 * PostgreSQL connection via Prisma Client
 */
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
    : [{ emit: 'event', level: 'error' }]
});

prisma.$on('warn',  (e) => logger.warn('Prisma:', e.message));
prisma.$on('error', (e) => logger.error('Prisma:', e.message));

// ── Auto-retry on stale/dropped pooled connections ──────────────────
// Supabase's connection pooler (Supavisor) proactively closes idle
// backend connections after a few minutes (visible in Supabase's own
// logs as "dropping database ... inactive auto-database"). Prisma's
// client doesn't always detect this until it tries to use the dead
// connection, which surfaced as intermittent 500s/408s on requests
// that landed right after a quiet period. This middleware transparently
// retries a query ONCE if it fails with a recognized "connection is
// gone" error — the retry opens a fresh connection and succeeds.
const TRANSIENT_CONNECTION_PATTERNS = [
  'Closed', 'closed the connection', 'Connection terminated',
  'connection is gone', "Can't reach database server",
  'ECONNRESET', 'ETIMEDOUT', 'server has gone away',
  'Engine is not yet connected', 'P1001', 'P1017'
];
const isTransientConnectionError = (err) => {
  const msg = String(err?.message || err);
  return TRANSIENT_CONNECTION_PATTERNS.some(p => msg.includes(p));
};

// Some dead connections don't throw at all — the socket looks alive
// (half-open) but the query just never returns, so the middleware's
// catch block above never fires. Race every query against a hard
// timeout so a hang is FORCED into a failure (which then hits the same
// retry path as an explicit connection error), instead of leaving the
// request to hang until the client's own 15s abort or Hostinger's
// proxy timeout — both of which produce a generic, unhelpful error
// with no chance to recover.
const QUERY_TIMEOUT_MS = 8000;
const withTimeout = (promise, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Query timed out after ${QUERY_TIMEOUT_MS}ms: ${label}`)), QUERY_TIMEOUT_MS))
]);

prisma.$use(async (params, next) => {
  const label = `${params.model}.${params.action}`;
  try {
    return await withTimeout(next(params), label);
  } catch (err) {
    const isTimeout = err.message && err.message.startsWith('Query timed out after');
    if (!isTransientConnectionError(err) && !isTimeout) throw err;
    logger.warn(`Prisma: ${isTimeout ? 'query timed out' : 'stale connection'} on ${label}, retrying once —`, err.message);
    await new Promise(r => setTimeout(r, 150)); // brief backoff before retry
    return withTimeout(next(params), label); // second attempt is also bounded; let it propagate if it fails too
  }
});

const connectDB = async () => {
  try {
    // Bound the connect attempt — a hanging (not just failing) connection
    // would otherwise stall server startup forever with no logs and no
    // response on any route, since app.listen() is never reached.
    await Promise.race([
      prisma.$connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB connect timed out after 8s')), 8000))
    ]);
    logger.info('✓ PostgreSQL connected (Prisma)');
    return prisma;
  } catch (err) {
    // Do NOT kill the process — a transient DB issue at boot would otherwise
    // crash the whole app and fail deployment. Log it and let the server
    // start; Prisma will retry the connection lazily on the first query, and
    // failures surface per-request (see /api/dbcheck) instead of taking the
    // entire API down.
    logger.error('PostgreSQL connection failed at startup (continuing):', err.message);
    return prisma;
  }
};

const disconnectDB = async () => {
  await prisma.$disconnect();
  logger.info('PostgreSQL disconnected');
};

module.exports = { prisma, connectDB, disconnectDB };
