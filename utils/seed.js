/**
 * Database seeder — creates admin user + test data for development
 * Run: npm run seed
 */
require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Order = require('../models/Order');
const logger = require('./logger');

const run = async () => {
  await connectDB();

  // Clear existing
  if (process.argv.includes('--fresh')) {
    logger.warn('Clearing database...');
    await Promise.all([
      User.deleteMany({}),
      Transaction.deleteMany({}),
      Order.deleteMany({})
    ]);
  }

  // Admin user
  const adminExists = await User.findOne({ email: 'admin@donpeesms.com' });
  if (!adminExists) {
    const admin = await User.create({
      firstName: 'Admin',
      lastName: 'User',
      username: 'admin',
      email: 'admin@donpeesms.com',
      password: 'Admin1234!',
      role: 'admin',
      emailVerified: true,
      walletBalance: 1000
    });
    logger.info(`✓ Admin created: ${admin.email} / Admin1234!`);
  }

  // Demo user
  const demoExists = await User.findOne({ email: 'demo@donpeesms.com' });
  if (!demoExists) {
    const demo = await User.create({
      firstName: 'John',
      lastName: 'Doe',
      username: 'johndoe',
      email: 'demo@donpeesms.com',
      password: 'Demo1234!',
      emailVerified: true,
      walletBalance: 24.50
    });

    // Sample transactions
    await Transaction.create([
      { user: demo._id, type: 'topup', amount: 25, balanceAfter: 25, method: 'stripe', status: 'success', description: 'Initial top-up' },
      { user: demo._id, type: 'purchase', amount: -0.50, balanceAfter: 24.50, method: 'wallet', status: 'success', description: 'Demo purchase' }
    ]);

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
