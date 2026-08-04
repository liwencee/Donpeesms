module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Tests import server.js, which keeps a Prisma client around; without
  // this Jest warns about open handles and hangs on exit.
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
