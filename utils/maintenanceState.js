/**
 * Maintenance-mode flag — cached in memory and backed by app_settings
 * (see supabase/migrations/0007_maintenance_mode.sql). A single Node
 * process serves this app (no cluster), so keeping the cache in sync on
 * every write avoids a DB round-trip per request while still surviving
 * restarts, since load() re-reads it at boot.
 */
const { supabase } = require('../config/supabase');
const logger = require('./logger');

let enabled = false;

const load = async () => {
  const { data, error } = await supabase
    .from('app_settings').select('value').eq('key', 'maintenance_mode').maybeSingle();
  // Fail open: a transient read error at boot should not accidentally
  // lock out the whole site. Same "stay alive" philosophy as server.js's
  // uncaughtException handler.
  if (error) { logger.error('Failed to load maintenance_mode setting:', error.message); return; }
  enabled = data?.value === true;
};

const isEnabled = () => enabled;

const setEnabled = async (next, userId) => {
  const { error } = await supabase
    .from('app_settings')
    .update({ value: next, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('key', 'maintenance_mode');
  if (error) throw error;
  enabled = next;
};

module.exports = { load, isEnabled, setEnabled };
