/**
 * middleware/maintenance.js — this one gate decides whether the entire
 * live site is reachable. A wrong exemption either strands the admin
 * outside their own panel with no way back in, or leaves a real user
 * route open during a lockout. Both failure modes only show up in
 * production, so they're locked in here instead.
 */
jest.mock('../utils/maintenanceState', () => ({
  isEnabled: jest.fn()
}));

const path = require('path');
const maintenanceState = require('../utils/maintenanceState');
const maintenance = require('../middleware/maintenance');

const mockReqRes = (reqPath) => {
  const req = { path: reqPath };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn(), sendFile: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
};

beforeEach(() => jest.clearAllMocks());

describe('when maintenance mode is off', () => {
  test('every request passes straight through', () => {
    maintenanceState.isEnabled.mockReturnValue(false);
    const { req, res, next } = mockReqRes('/api/wallet');
    maintenance(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('when maintenance mode is on', () => {
  beforeEach(() => maintenanceState.isEnabled.mockReturnValue(true));

  test.each([
    '/health',
    '/admin',
    '/api/admin/maintenance',
    '/api/admin/users/1/ban',
    '/api/payments/webhooks/drexpay',
    '/api/users/me'
  ])('%s stays reachable', (reqPath) => {
    const { req, res, next } = mockReqRes(reqPath);
    maintenance(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('static assets (anything with a file extension) stay reachable', () => {
    const { req, res, next } = mockReqRes('/app.js');
    maintenance(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  // The bare prefix without a following user id/action must not
  // accidentally match every route via a loose startsWith('/api/admin').
  test('/api/adminwhatever (prefix collision, not a real sub-path) is NOT exempt', () => {
    const { req, res, next } = mockReqRes('/api/adminwhatever');
    maintenance(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  test('other /api/users/* routes stay locked (only /me is exempt)', () => {
    const { req, res, next } = mockReqRes('/api/users/dashboard-stats');
    maintenance(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  test('a regular API call gets 503 JSON with Retry-After, not HTML', () => {
    const { req, res, next } = mockReqRes('/api/wallet');
    maintenance(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  test.each(['/', '/features', '/dashboard'])('a page navigation to %s gets the maintenance page, not JSON', (reqPath) => {
    const { req, res, next } = mockReqRes(reqPath);
    maintenance(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).not.toHaveBeenCalled();
    expect(res.sendFile).toHaveBeenCalledWith(path.join(__dirname, '..', 'public', 'maintenance.html'));
  });
});
