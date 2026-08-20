/**
 * Full site lockdown.
 *
 * While the site_lockdown flag is set, nothing is reachable: pages get
 * public/maintenance.html, API calls get 503 JSON. The admin panel and
 * the dashboard are locked out too — this is deliberate, so "the site is
 * down" means down, not down-for-visitors-only.
 *
 * That makes the DATABASE the only way back in. utils/lockdownFlag.js
 * re-reads the flag on a short TTL, so setting site_lockdown to false
 * unlocks a running server on its own within seconds — no restart, and
 * no need to reach an admin page that this middleware is itself
 * blocking. Do not "improve" this by exempting /admin without also
 * keeping that database path working.
 *
 * Two things stay reachable, by MOUNT POSITION rather than by any check
 * in here — both are registered in server.js before this middleware:
 *
 *   /api/payments/*  (line ~114) — the DrexPay webhook. A customer whose
 *                    bank transfer confirms during a lockdown must still
 *                    have their wallet credited; blocking it would take
 *                    their money and silently not deliver.
 *   /health          (line ~146) — the host's uptime probe. Answering
 *                    503 here invites the platform to treat the app as
 *                    unhealthy and restart it in a loop.
 *
 * Moving this mount earlier in server.js would silently swallow both.
 */
const path = require('path');
const lockdownFlag = require('../utils/lockdownFlag');

const MAINTENANCE_PAGE = path.join(__dirname, '..', 'public', 'maintenance.html');

module.exports = (req, res, next) => {
  if (!lockdownFlag.isEnabled()) return next();

  // Retry-After marks this as temporary, so search engines treat it as a
  // maintenance window instead of deindexing the site.
  res.status(503);
  res.set('Retry-After', '3600');
  res.set('Cache-Control', 'no-store');

  if (req.path.startsWith('/api/')) {
    return res.json({ success: false, message: 'The site is temporarily unavailable for maintenance.' });
  }
  // Static assets are locked too, but the maintenance page is fully
  // self-contained (inline CSS, no external requests), so it renders.
  return res.sendFile(MAINTENANCE_PAGE);
};
