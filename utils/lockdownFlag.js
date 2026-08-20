/**
 * site_lockdown flag, read through a short-lived cache.
 *
 * The previous implementation of this feature read the flag ONCE at boot,
 * so changing the value in the database never reached a running server —
 * turning maintenance on did nothing to a live process, and turning it
 * back off couldn't be relied on to undo it. That is the bug this file
 * exists to not repeat: the value is re-read every TTL_MS, so a change
 * made directly in the database propagates to a live server on its own,
 * with no restart and no admin UI in the loop.
 *
 * The refresh runs in the BACKGROUND rather than blocking the request
 * that noticed the staleness — maintenance mode tolerates being a few
 * seconds out of date, and no visitor should wait on a database round
 * trip to find out whether the page they asked for is available.
 */
const { supabase } = require('../config/supabase');
const logger = require('./logger');

const TTL_MS = 5000;

let enabled   = false;
let fetchedAt = 0;
let inflight  = null;

const read = async () => {
  const { data, error } = await supabase
    .from('app_settings').select('value').eq('key', 'site_lockdown').maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value === true;
};

const refresh = () => {
  if (inflight) return inflight;
  inflight = read()
    .then((value) => { enabled = value; fetchedAt = Date.now(); })
    // Keep serving the last known value on a read failure. Neither
    // direction is safe to guess at: inventing `true` would black out a
    // healthy site over a database blip, and inventing `false` would
    // quietly un-maintenance a site somebody deliberately took down.
    .catch((err) => { logger.warn('site_lockdown read failed, keeping last known value:', err.message); })
    .finally(() => { inflight = null; });
  return inflight;
};

/** Sync — never blocks a request. Kicks off a background refresh if stale. */
const isEnabled = () => {
  if (Date.now() - fetchedAt > TTL_MS) refresh();
  return enabled;
};

/** Awaited once at boot so the very first requests aren't guessing. */
const load = () => refresh();

module.exports = { isEnabled, load, TTL_MS };
