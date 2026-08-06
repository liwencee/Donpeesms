module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Tests import server.js; without this Jest warns about an open handle
  // and hangs on exit (harmless — nothing to explicitly close on the
  // Supabase client, unlike Prisma's query-engine process previously).
  forceExit: true,
  testTimeout: 20000,
  setupFiles: ['<rootDir>/tests/setup.js'],
  // Only report coverage on our own source, not deps or the frontend bundle.
  collectCoverageFrom: [
    'controllers/**/*.js',
    'routes/**/*.js',
    'middleware/**/*.js',
    'utils/**/*.js',
    'config/**/*.js'
  ]
};
