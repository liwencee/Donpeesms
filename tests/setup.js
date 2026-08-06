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

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test_only_cookie_secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);

// Dummy Supabase credentials. Smoke tests must not need a real Supabase
// project — supabase-js only makes a network call when a route actually
// queries it, and every route tested here either doesn't touch the DB
// or is expected to fail auth before it would.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
