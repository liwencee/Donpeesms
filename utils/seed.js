/**
 * Database seeder — creates admin user + test data
 * Run: npm run seed
 * Run: npm run seed -- --fresh   (wipes all data first)
 */
require('dotenv').config();
const { prisma, connectDB, disconnectDB } = require('../config/db');
const { hashPassword, generateReferralCode } = require('../models/User');
const logger = require('./logger');

const run = async () => {
  await connectDB();

  // ── Wipe everything ──────────────────────────────────────────
  if (process.argv.includes('--fresh')) {
    logger.warn('Clearing database...');
    // Break self-referential FK first (referredById → id)
    await prisma.user.updateMany({ data: { referredById: null } });
    // Cascade: deleting users cascade-deletes transactions, orders, apiKeys
    await prisma.user.deleteMany({});
    logger.warn('Database cleared');
  }

  // ── Admin user ───────────────────────────────────────────────
  const adminExists = await prisma.user.findFirst({ where: { email: 'admin@donpeesms.com' } });
  if (!adminExists) {
    const admin = await prisma.user.create({
      data: {
        firstName:    'Admin',
        lastName:     'User',
        username:     'admin',
        email:        'admin@donpeesms.com',
        password:     await hashPassword('Admin1234!'),
        role:         'admin',
        emailVerified: true,
        walletBalance: 1000,
        referralCode: 'admin0001'
      }
    });
    logger.info(`✓ Admin created: ${admin.email} / Admin1234!`);
  }

  // ── Demo user ────────────────────────────────────────────────
  const demoExists = await prisma.user.findFirst({ where: { email: 'demo@donpeesms.com' } });
  if (!demoExists) {
    const demo = await prisma.user.create({
      data: {
        firstName:    'John',
        lastName:     'Doe',
        username:     'johndoe',
        email:        'demo@donpeesms.com',
        password:     await hashPassword('Demo1234!'),
        emailVerified: true,
        walletBalance: 24.50,
        referralCode: generateReferralCode('johndoe')
      }
    });

    // Sample transactions
    await prisma.transaction.createMany({
      data: [
        {
          userId:      demo.id,
          type:        'topup',
          amount:      25,
          balanceAfter: 25,
          method:      'stripe',
          status:      'success',
          description: 'Initial top-up'
        },
        {
          userId:      demo.id,
          type:        'purchase',
          amount:      -0.50,
          balanceAfter: 24.50,
          method:      'wallet',
          status:      'success',
          description: 'Demo purchase'
        }
      ]
    });

    logger.info(`✓ Demo user created: ${demo.email} / Demo1234!`);
  }

  logger.info('✓ Seed complete');
  await disconnectDB();
  process.exit(0);
};

run().catch(err => {
  logger.error('Seed failed:', err);
  process.exit(1);
});
