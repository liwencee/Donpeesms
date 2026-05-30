/**
 * Auth middleware — verifies JWT, attaches user to req
 */
const { verifyAccessToken } = require('../utils/jwt');
const User = require('../models/User');
const ApiKey = require('../models/ApiKey');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

const extractToken = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1];
  }
  if (req.cookies?.accessToken) return req.cookies.accessToken;
  return null;
};

/**
 * Protect — requires valid JWT (browser session)
 */
const protect = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Authentication required');

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    throw ApiError.unauthorized(
      err.name === 'TokenExpiredError' ? 'Session expired, please login again' : 'Invalid token'
    );
  }

  const user = await User.findById(decoded.id);
  if (!user) throw ApiError.unauthorized('User no longer exists');
  if (user.status !== 'active') throw ApiError.forbidden(`Account ${user.status}`);

  req.user = user;
  req.userId = user._id;
  next();
});

/**
 * Require email-verified
 */
const requireEmailVerified = (req, res, next) => {
  if (!req.user?.emailVerified) {
    throw ApiError.forbidden('Email verification required');
  }
  next();
};

/**
 * Role-based access
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    throw ApiError.forbidden('Insufficient permissions');
  }
  next();
};

/**
 * API Key auth — for developer endpoints
 */
const apiKeyAuth = asyncHandler(async (req, res, next) => {
  const rawKey = req.headers['x-api-key'] ||
    (req.headers.authorization?.startsWith('Bearer dps_') && req.headers.authorization.split(' ')[1]);

  if (!rawKey) throw ApiError.unauthorized('API key required');

  const key = await ApiKey.findByKey(rawKey).populate('user');
  if (!key) throw ApiError.unauthorized('Invalid API key');
  if (key.expiresAt && key.expiresAt < Date.now()) throw ApiError.unauthorized('API key expired');
  if (!key.user || key.user.status !== 'active') throw ApiError.forbidden('User account inactive');

  // Update usage stats (fire and forget)
  ApiKey.updateOne(
    { _id: key._id },
    { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date(), lastUsedIp: req.ip } }
  ).exec();

  req.user = key.user;
  req.userId = key.user._id;
  req.apiKey = key;
  next();
});

module.exports = { protect, requireEmailVerified, requireRole, apiKeyAuth };
