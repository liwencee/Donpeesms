/**
 * MongoDB connection (Mongoose)
 */
const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

let connection = null;

const connectDB = async () => {
  if (connection) return connection;

  try {
    mongoose.set('strictQuery', true);

    connection = await mongoose.connect(env.mongoUri, {
      maxPoolSize: 50,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      family: 4
    });

    logger.info(`✓ MongoDB connected: ${connection.connection.host}/${connection.connection.name}`);

    mongoose.connection.on('error', (err) => logger.error('MongoDB error:', err));
    mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

    return connection;
  } catch (err) {
    logger.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
};

const disconnectDB = async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected');
  }
};

module.exports = { connectDB, disconnectDB };
