/**
 * Full-site lockout. When enabled: API requests get 503, page
 * navigations get the static maintenance page — except the admin panel
 * (/admin + /api/admin/*), GET /api/users/me (needed to load the admin's
 * own session), /health, the DrexPay webhook (an in-flight bank transfer
 * must still be able to credit a wallet even while the site is down),
 * and static assets (inert without the API, and the admin SPA needs them
 * to render at all).
 */
const path = require('path');
const maintenanceState = require('../utils/maintenanceState');

const EXEMPT_EXACT = ['/admin', '/health'];
const EXEMPT_PREFIXES = ['/api/admin', '/api/payments'];
const EXEMPT_API_EXACT = ['/api/users/me'];

module.exports = (req, res, next) => {
  if (!maintenanceState.isEnabled()) return next();

  if (EXEMPT_EXACT.includes(req.path)) return next();
  if (EXEMPT_API_EXACT.includes(req.path)) return next();
  if (EXEMPT_PREFIXES.some(p => req.path.startsWith(p + '/') || req.path === p)) return next();
  if (path.extname(req.path)) return next();

  if (req.path.startsWith('/api/')) {
    res.set('Retry-After', '300');
    return res.status(503).json({
      success: false,
      status: 'error',
      message: 'Site is under maintenance. Please check back soon.'
    });
  }

  res.status(503).sendFile(path.join(__dirname, '..', 'public', 'maintenance.html'));
};
