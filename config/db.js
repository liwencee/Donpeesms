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

prisma.$use(async (params, next) => {
  try {
    return await next(params);
  } catch (err) {
    if (!isTransientConnectionError(err)) throw err;
    logger.warn(`Prisma: stale connection on ${params.model}.${params.action}, retrying once —`, err.message);
    await new Promise(r => setTimeout(r, 150)); // brief backoff before retry
    return next(params); // let a second failure propagate normally
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
