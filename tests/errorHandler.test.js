/**
 * errorHandler status-code mapping.
 *
 * The controllers re-throw raw supabase-js errors where a constraint
 * violation is plausible (product/category and api_provider writes), so
 * this mapping is what turns a duplicate name into a 409 instead of a
 * 500. If someone re-wraps those in `new ApiError(500, ...)` the fix is
 * silently undone, which is what these guard.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { errorHandler } = require('../middleware/errorHandler');
const ApiError = require('../utils/apiError');

const run = (err) => {
  const req = { originalUrl: '/api/admin/categories', method: 'POST', ip: '127.0.0.1' };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  errorHandler(err, req, res, jest.fn());
  return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
};

describe('Postgres / PostgREST error mapping', () => {
  test('23505 unique violation → 409, naming the offending column', () => {
    const { status, body } = run({
      code: '23505',
      message: 'duplicate key value violates unique constraint "categories_name_key"',
      details: 'Key (name)=(Prepaid) already exists.'
    });
    expect(status).toBe(409);
    expect(body.message).toBe('name already exists');
  });

  test('23505 without parseable details still returns 409', () => {
    expect(run({ code: '23505', message: 'duplicate key' }).status).toBe(409);
  });

  test('23503 foreign key violation → 400', () => {
    expect(run({ code: '23503', message: 'violates foreign key constraint' }).status).toBe(400);
  });

  test('23514 check violation → 400', () => {
    expect(run({ code: '23514', message: 'violates check constraint' }).status).toBe(400);
  });

  test('PGRST116 no rows → 404', () => {
    expect(run({ code: 'PGRST116', message: 'JSON object requested, 0 rows' }).status).toBe(404);
  });

  test('an unrecognised code still becomes a generic 500', () => {
    const { status, body } = run({ code: 'ECONNRESET', message: 'socket hang up' });
    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error'); // never leak internals
  });
});

describe('existing branches still work', () => {
  test('an explicit ApiError passes through untouched', () => {
    const { status, body } = run(ApiError.notFound('Order not found'));
    expect(status).toBe(404);
    expect(body.message).toBe('Order not found');
  });

  test('malformed JSON → 400', () => {
    expect(run({ type: 'entity.parse.failed', message: 'Unexpected token' }).status).toBe(400);
  });

  test('payload too large → 413', () => {
    expect(run({ type: 'entity.too.large', message: 'request entity too large' }).status).toBe(413);
  });

  test('expired JWT → 401', () => {
    expect(run({ name: 'TokenExpiredError', message: 'jwt expired' }).status).toBe(401);
  });
});
