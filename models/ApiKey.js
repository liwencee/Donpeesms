/**
 * ApiKey helpers
 */
const crypto = require('crypto');
const { supabase } = require('../config/supabase');

const generateKey = () => {
  const raw    = 'dps_live_' + crypto.randomBytes(24).toString('hex');
  const hash   = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.substring(0, 16);
  return { raw, hash, prefix };
};

const findByKey = async (rawKey) => {
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const { data, error } = await supabase
    .from('api_keys')
    .select('*, profiles(*)')
    .eq('key_hash', hash)
    .eq('active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
};

module.exports = { generateKey, findByKey };
