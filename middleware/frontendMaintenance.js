/**
 * Frontend-only maintenance gate.
 *
 * Serves public/maintenance.html in place of the SPA while the
 * frontend_maintenance flag is set. Deliberately narrower than the
 * previous whole-site lockout — the API stays up, so anything already
 * running against it (a DrexPay webhook confirming a bank transfer, an
 * integrator's API key) keeps working rather than failing during what is
 * meant to be a front-of-house pause.
 *
 * Untouched while maintenance is on:
 *   /api/*   — including the DrexPay webhook and the developer API
 *   /health  — uptime checks must not report a site as down
 *   /admin   — so the panel is still reachable
 *   anything with a file extension — static assets
 */
const path = require('path');
const maintenanceFlag = require('../utils/maintenanceFlag');

const MAINTENANCE_PAGE = path.join(__dirname, '..', 'public', 'maintenance.html');

module.exports = (req, res, next) => {
  if (!maintenanceFlag.isEnabled()) return next();

  if (req.path === '/health') return next();
  if (req.path === '/admin' || req.path.startsWith('/admin/')) return next();
  if (req.path.startsWith('/api/')) return next();
  if (path.extname(req.path)) return next();

  // 503 + Retry-After so crawlers treat this as temporary and don't
  // deindex the site over a maintenance window.
  res.status(503);
  res.set('Retry-After', '3600');
  res.set('Cache-Control', 'no-store');
  res.sendFile(MAINTENANCE_PAGE);
};
