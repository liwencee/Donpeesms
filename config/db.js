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

const connectDB = async () => {
  try {
    await prisma.$connect();
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
