/**
 * Smoke tests — the "is the site fundamentally working?" suite.
 *
 * These target the exact failure modes that caused real outages:
 *   - the app failing to boot at all (missing env var, crash on load)
 *   - static frontend not being served
 *   - auth endpoints returning 500 instead of a proper status
 *   - admin routes being reachable without credentials
 *   - a single uncaught error taking the whole process down
 *
 * Deliberately NO database required: these must run in CI on every push
 * without secrets, so they catch "the app is broken" before deploy.
 */
process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

// Only the Supabase CLIENT is mocked — the Express app, its routes,
// static file serving and the SPA fallback are all the real thing,
// which is the whole point of this suite. Without this, the
// "garbage token returns 401" test made a live HTTPS round-trip to
// whatever SUPABASE_URL resolved to just to be told the token is bad.
jest.mock('../config/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: { message: 'invalid JWT' } }),
      admin: { getUserById: jest.fn().mockResolvedValue({ data: { user: null }, error: null }) }
    },
    from: jest.fn(),
    rpc: jest.fn().mockResolvedValue({ data: null, error: null })
  }
}));

const request = require('supertest');
const app = require('../server');

describe('app boots', () => {
  test('server module loads and exports an Express app', () => {
    expect(app).toBeDefined();
    expect(typeof app).toBe('function'); // express app is a function
  });

  // Regression guard: server.js loads .env with `override` so a broken
  // host env panel can't win — but the worktree .env carries
  // NODE_ENV=production and live Supabase credentials. An unconditional
  // override flipped NODE_ENV away from 'test', which made start() bind
  // a port and arm the 60-second auto-expire/auto-refund job against the
  // REAL project for the duration of the test run.
  test('requiring server.js does not clobber the test environment', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.SUPABASE_URL).toBe('https://test.supabase.co');
  });
});

describe('health + static frontend', () => {
  test('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET / serves the frontend HTML', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  test('SPA deep link falls back to index.html (not 404)', async () => {
    const res = await request(app).get('/pricing');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  test('/admin route serves the app (admin gate is client-side + API-enforced)', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(200);
  });

  test('static asset is served', async () => {
    const res = await request(app).get('/styles.css');
    expect(res.status).toBe(200);
  });
});

describe('security: admin APIs reject unauthenticated callers', () => {
  // Regression guard: these must never be publicly readable. A 401/403
  // is correct; a 200 would mean the data is exposed, and a 500 would
  // mean the auth layer itself is broken.
  const adminRoutes = [
    '/api/admin/products',
    '/api/admin/categories',
    '/api/admin/users',
    '/api/admin/orders',
    '/api/admin/api-providers',
    '/api/dbcheck',
    '/api/numbers/provider-check'
  ];

  test.each(adminRoutes)('GET %s requires auth', async (route) => {
    const res = await request(app).get(route);
    expect([401, 403]).toContain(res.status);
  });
});

describe('protected endpoints respond correctly (no 500s)', () => {
  test('POST to a protected route without a token returns 401, not a crash', async () => {
    const res = await request(app)
      .post('/api/wallet/topup')
      .send({ amount: 10, method: 'stripe' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(401);
  });

  test('protected route without a token returns 401', async () => {
    const res = await request(app).get('/api/users/me');
    expect(res.status).toBe(401);
  });

  test('protected route with a garbage token returns 401 (not 500)', async () => {
    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', 'Bearer not.a.real.token');
    expect(res.status).toBe(401);
  });
});

describe('error handling', () => {
  test('unknown API route returns a clean 404 JSON', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test('malformed JSON body does not crash the server', async () => {
    const res = await request(app)
      .post('/api/wallet/topup')
      .set('Content-Type', 'application/json')
      .send('{"bad json"');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('public API shape', () => {
  test('GET /api returns the API index', async () => {
    const res = await request(app).get('/api');
    expect(res.status).toBe(200);
    expect(res.body.name).toMatch(/API/i);
  });
});
