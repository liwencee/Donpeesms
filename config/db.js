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
    logger.error('PostgreSQL connection failed:', err.message);
    process.exit(1);
  }
};

const disconnectDB = async () => {
  await prisma.$disconnect();
  logger.info('PostgreSQL disconnected');
};

module.exports = { prisma, connectDB, disconnectDB };
