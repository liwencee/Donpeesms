jest.mock('../config/supabase', () => ({
  supabase: {
    auth: { getUser: jest.fn() },
    from: jest.fn()
  }
}));

const { supabase } = require('../config/supabase');
const { protect } = require('../middleware/auth');

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
