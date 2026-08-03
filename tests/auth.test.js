jest.mock('../config/supabase', () => ({
  supabase: {
    auth: { getUser: jest.fn() },
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
    supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid JWT' } });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer bad.token.here' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('rejects a valid token with no matching profile row', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    supabase.from.mockReturnValue({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'no rows' } }) }) })
    });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer good.token' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('attaches req.user and req.userId on success', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    supabase.from.mockReturnValue({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'u1', status: 'active', role: 'user' }, error: null }) }) })
    });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer good.token' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(req.userId).toBe('u1');
    expect(req.user.role).toBe('user');
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
    const { req, res, next } = mockReqRes({ 'x-api-key': 'valid.key' });
    req.ip = '127.0.0.1';
    await apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(req.userId).toBe('u1');
    expect(req.user.role).toBe('admin');
    expect(req.apiKey.id).toBe('key1');
    expect(supabase.rpc).toHaveBeenCalledWith('increment_api_key_usage', { p_key_id: 'key1', p_ip: '127.0.0.1' });
  });
});
