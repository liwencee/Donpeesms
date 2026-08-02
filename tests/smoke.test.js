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
 * DB-dependent behaviour is covered separately (see db.test.js), which
 * skips itself when DATABASE_URL isn't configured.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_not_used_in_production_0123456789abcdef';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_secret_not_used_in_prod_0123456789ab';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/db';

const request = require('supertest');
const app = require('../server');

describe('app boots', () => {
  test('server module loads and exports an Express app', () => {
    expect(app).toBeDefined();
    expect(typeof app).toBe('function'); // express app is a function
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

describe('auth endpoints respond correctly (no 500s)', () => {
  test('login with missing body returns a 4xx, not a crash', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({})
      .set('Content-Type', 'application/json');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('login with malformed email returns a 4xx, not a crash', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: 'x' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('protected route without a token returns 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('protected route with a garbage token returns 401 (not 500)', async () => {
    const res = await request(app)
      .get('/api/auth/me')
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
      .post('/api/auth/login')
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
