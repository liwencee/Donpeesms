/**
 * Jest global teardown — closes Prisma's query-engine process cleanly
 * so the test run exits without a dangling child process.
 */
module.exports = async () => {
  try {
    const { disconnectDB } = require('../config/db');
    await disconnectDB();
  } catch (_e) {
    // Nothing to close if the module never loaded — fine.
  }
};
