/**
 * Auth middleware — verifies a Supabase-issued JWT or a developer API
 * key, attaches the matching profile to req.
 */
const { supabase } = require('../config/supabase');
const { PROFILE_COLUMNS } = require('../models/User');
const { findByKey } = require('../models/ApiKey');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { toCamelCase } = require('../utils/caseMapper');
const logger       = require('../utils/logger');

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

  // `email` lives in auth.users, not profiles (so it is absent from
  // PROFILE_COLUMNS). Downstream code — DrexPay payment links, order
  // and top-up confirmation emails — reads req.user.email, and without
  // this every one of those silently sent to `undefined`. The
  // authenticated user object already carries it: no extra query.
  req.user   = { ...user, email: authData.user.email };
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

  const key = await findByKey(rawKey);

  if (!key)                                        throw ApiError.unauthorized('Invalid API key');
  if (key.expires_at && new Date(key.expires_at) < new Date()) throw ApiError.unauthorized('API key expired');
  if (!key.profiles || key.profiles.status !== 'active')       throw ApiError.forbidden('User account inactive');

  supabase.rpc('increment_api_key_usage', { p_key_id: key.id, p_ip: req.ip })
    .then(() => {}, (err) => logger.warn('API key usage tracking failed:', err.message)); // fire-and-forget, but log if it fails

  // Same reason as in protect(): req.user.email is needed downstream
  // (POST /api/v1/numbers sends an order confirmation). There is no
  // token to read it from here, so look it up — and never fail the
  // request over it; a missing email only costs an email.
  let email;
  try {
    const { data: authUser, error: authErr } = await supabase.auth.admin.getUserById(key.profiles.id);
    if (authErr) throw authErr;
    email = authUser?.user?.email;
  } catch (err) {
    logger.warn(`apiKeyAuth: could not resolve email for user ${key.profiles.id}:`, err.message);
  }

  req.user   = { ...toCamelCase(key.profiles), email };
  req.userId = key.profiles.id;
  req.apiKey = toCamelCase(key);
  next();
});

module.exports = { protect, requireRole, apiKeyAuth };
