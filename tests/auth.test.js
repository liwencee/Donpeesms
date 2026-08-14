jest.mock('../config/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
      // apiKeyAuth resolves the account's email (which lives in
      // auth.users, not profiles) so downstream email sending works.
      admin: { getUserById: jest.fn() }
    },
    from: jest.fn(),
    rpc: jest.fn()
  }
}));

jest.mock('../models/ApiKey', () => ({
  findByKey: jest.fn()
}));

jest.mock('../utils/logger', () => ({
  warn: jest.fn()
}));

const { supabase } = require('../config/supabase');
const { protect, apiKeyAuth } = require('../middleware/auth');
const { findByKey } = require('../models/ApiKey');

const mockReqRes = (headers = {}) => {
  const req = { headers, cookies: {} };
  const res = {};
  const next = jest.fn();
  return { req, res, next };
};

describe('protect middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects when no token is present', async () => {
    const { req, res, next } = mockReqRes();
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('rejects an invalid/expired token', async () => {
    // The real shape a malformed token gets back, confirmed live against
    // Supabase Auth — note status is 403, NOT 401. name: 'AuthApiError'
    // is the actual signal protect() keys off (see the "transient
    // errors" tests below for the contrast): it means the Auth server
    // itself examined the token and rejected it, for any reason.
    supabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', status: 403, code: 'bad_jwt', message: 'invalid JWT' }
    });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer bad.token.here' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('rejects a valid token with no matching profile row', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    supabase.from.mockReturnValue({
      // PGRST116 is PostgREST's real code for .single() matching 0 rows —
      // an actually-deleted account, which is the case this asserts.
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'no rows', code: 'PGRST116' } }) }) })
    });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer good.token' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  // REGRESSION: these two used to be indistinguishable from a genuinely
  // bad session — any error from either Supabase call became a 401, and
  // the frontend's api() helper signs a user out on ANY 401 from us. A
  // transient Auth-service hiccup or a DB timeout was silently ending
  // real, valid sessions on every affected request, not just at login.
  test('a network-level failure reaching Supabase Auth (not a real rejection) is NOT treated as an invalid session', async () => {
    // supabase-js's real signal for "couldn't reach the Auth server at
    // all" is a different error type than AuthApiError (e.g.
    // AuthRetryableFetchError) — this must not collapse into "bad token".
    supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthRetryableFetchError', message: 'fetch failed' } });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer good.token' });
    await protect(req, res, next);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(503);
    expect(err.statusCode).not.toBe(401);
  });

  test('a database error fetching the profile (not "no such row") is NOT treated as an invalid session', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    supabase.from.mockReturnValue({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'connection timeout', code: '57014' } }) }) })
    });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer good.token' });
    await protect(req, res, next);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(500);
    expect(err.statusCode).not.toBe(401);
  });

  test('attaches req.user and req.userId on success', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.com' } }, error: null });
    supabase.from.mockReturnValue({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'u1', status: 'active', role: 'user' }, error: null }) }) })
    });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer good.token' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(req.userId).toBe('u1');
    expect(req.user.role).toBe('user');
  });

  // Regression guard: `email` is NOT a profiles column (it lives in
  // auth.users), so it must come off the verified token's user object.
  // Without it, DrexPay payment links and every confirmation email
  // silently addressed `undefined`.
  test('attaches the account email from the verified token', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'buyer@example.com' } }, error: null });
    supabase.from.mockReturnValue({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'u1', status: 'active', role: 'user' }, error: null }) }) })
    });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer good.token' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.user.email).toBe('buyer@example.com');
  });

  test('rejects a suspended/banned account', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    supabase.from.mockReturnValue({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'u1', status: 'banned', role: 'user' }, error: null }) }) })
    });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer good.token' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});

describe('apiKeyAuth middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects when no API key is provided', async () => {
    const { req, res, next } = mockReqRes();
    req.ip = '127.0.0.1';
    await apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('rejects an invalid API key', async () => {
    findByKey.mockResolvedValue(null);
    const { req, res, next } = mockReqRes({ 'x-api-key': 'invalid.key' });
    req.ip = '127.0.0.1';
    await apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('rejects an expired API key', async () => {
    const expiredDate = new Date(Date.now() - 1000); // past date
    findByKey.mockResolvedValue({
      id: 'key1',
      expires_at: expiredDate.toISOString(),
      profiles: { id: 'u1', status: 'active', role: 'user' },
      usage_count: 0
    });
    const { req, res, next } = mockReqRes({ 'x-api-key': 'valid.but.expired' });
    req.ip = '127.0.0.1';
    await apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('rejects an API key for an inactive account', async () => {
    findByKey.mockResolvedValue({
      id: 'key1',
      expires_at: null,
      profiles: { id: 'u1', status: 'banned', role: 'user' },
      usage_count: 0
    });
    const { req, res, next } = mockReqRes({ 'x-api-key': 'valid.key' });
    req.ip = '127.0.0.1';
    await apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  test('attaches req.user, req.userId, and req.apiKey on success', async () => {
    const futureDate = new Date(Date.now() + 1000); // future date
    findByKey.mockResolvedValue({
      id: 'key1',
      expires_at: futureDate.toISOString(),
      profiles: { id: 'u1', status: 'active', role: 'admin' },
      usage_count: 42
    });
    supabase.rpc.mockResolvedValue({ data: null, error: null });
    supabase.auth.admin.getUserById.mockResolvedValue({ data: { user: { id: 'u1', email: 'dev@example.com' } }, error: null });
    const { req, res, next } = mockReqRes({ 'x-api-key': 'valid.key' });
    req.ip = '127.0.0.1';
    await apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(req.userId).toBe('u1');
    expect(req.user.role).toBe('admin');
    expect(req.user.email).toBe('dev@example.com');
    expect(req.apiKey.id).toBe('key1');
    expect(supabase.rpc).toHaveBeenCalledWith('increment_api_key_usage', { p_key_id: 'key1', p_ip: '127.0.0.1' });
  });

  // The email lookup is a convenience, not a gate — an auth-admin
  // hiccup must not take down the whole developer API.
  test('still authenticates when the email lookup fails', async () => {
    findByKey.mockResolvedValue({
      id: 'key1',
      expires_at: null,
      profiles: { id: 'u1', status: 'active', role: 'user' },
      usage_count: 0
    });
    supabase.rpc.mockResolvedValue({ data: null, error: null });
    supabase.auth.admin.getUserById.mockResolvedValue({ data: null, error: { message: 'auth service down' } });
    const { req, res, next } = mockReqRes({ 'x-api-key': 'valid.key' });
    req.ip = '127.0.0.1';
    await apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBe('u1');
    expect(req.user.email).toBeUndefined();
  });
});
