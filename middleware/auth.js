/**
 * Auth middleware — verifies a Supabase-issued JWT or a developer API
 * key, attaches the matching profile to req.
 */
const crypto       = require('crypto');
const { supabase } = require('../config/supabase');
const { PROFILE_COLUMNS } = require('../models/User');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { toCamelCase } = require('../utils/caseMapper');

const extractToken = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1];
  }
  return null;
};

/**
 * protect — requires a valid Supabase session token
 */
const protect = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Authentication required');

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) {
    throw ApiError.unauthorized('Invalid or expired session');
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', authData.user.id)
    .single();

  if (profileError || !profile) throw ApiError.unauthorized('User no longer exists');

  const user = toCamelCase(profile);
  if (user.status !== 'active') throw ApiError.forbidden(`Account ${user.status}`);

  req.user   = user;
  req.userId = user.id;
  next();
});

/**
 * requireRole — role-based access control
 */
const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) throw ApiError.forbidden('Insufficient permissions');
  next();
};

/**
 * apiKeyAuth — for developer endpoints (/api/v1/*)
 */
const apiKeyAuth = asyncHandler(async (req, res, next) => {
  const rawKey = req.headers['x-api-key'] ||
    (req.headers.authorization?.startsWith('Bearer dps_') && req.headers.authorization.split(' ')[1]);

  if (!rawKey) throw ApiError.unauthorized('API key required');

  const { findByKey } = require('../models/ApiKey');
  const key = await findByKey(rawKey);

  if (!key)                                        throw ApiError.unauthorized('Invalid API key');
  if (key.expires_at && new Date(key.expires_at) < new Date()) throw ApiError.unauthorized('API key expired');
  if (!key.profiles || key.profiles.status !== 'active')       throw ApiError.forbidden('User account inactive');

  const { supabase: sb } = require('../config/supabase');
  sb.from('api_keys')
    .update({ usage_count: key.usage_count + 1, last_used_at: new Date().toISOString(), last_used_ip: req.ip })
    .eq('id', key.id)
    .then(() => {}, () => {}); // fire-and-forget

  req.user   = toCamelCase(key.profiles);
  req.userId = key.profiles.id;
  req.apiKey = toCamelCase(key);
  next();
});

module.exports = { protect, requireRole, apiKeyAuth };
