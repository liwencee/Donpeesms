/**
 * Jest setup — runs before every test file.
 *
 * Sets NODE_ENV=test so server.js skips start() (no port binding, no
 * background jobs), and provides throwaway values for the env vars the
 * app needs to load. These are dummy values used only in-process; no
 * real secrets are required to run the smoke suite, which is what lets
 * it run in CI on every push without any configuration.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // quiet request logging during tests

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_only_jwt_secret_0123456789abcdef0123456789abcdef';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_only_refresh_secret_abcdef0123456789abcdef0123';
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test_only_cookie_secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '4'; // fast hashing in tests

// Point at an unreachable DB by default. Smoke tests must not need a
// real database — they verify the app boots and routes behave, which is
// exactly what has broken in production before.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:59999/testdb';
process.env.DIRECT_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
