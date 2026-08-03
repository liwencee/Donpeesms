/**
 * Supabase client — replaces config/db.js (Prisma). Talks to Supabase
 * over HTTPS (PostgREST), so the Node process never holds a persistent
 * Postgres connection open — this is what removes the entire class of
 * connection-pool-exhaustion / idle-connection-drop bugs Prisma had on
 * Hostinger.
 */
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocket }
  }
);

module.exports = { supabase };
