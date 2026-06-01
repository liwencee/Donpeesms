/**
 * Auth middleware — verifies JWT or API key, attaches user to req
 */
const crypto       = require('crypto');
const { verifyAccessToken } = require('../utils/jwt');
const { prisma }   = require('../config/db');
const { USER_PUBLIC } = require('../models/User');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

const extractToken = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1];
  }
  if (req.cookies?.accessToken) return req.cookies.accessToken;
  return null;
};

/**
 * protect — requires valid JWT (browser session)
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

  const user = await prisma.user.findUnique({ where: { id: decoded.id }, select: USER_PUBLIC });
  if (!user) throw ApiError.unauthorized('User no longer exists');
  if (user.status !== 'active') throw ApiError.forbidden(`Account ${user.status}`);

  req.user   = user;
  req.userId = user.id;
  next();
});

/**
 * requireEmailVerified
 */
const requireEmailVerified = (req, _res, next) => {
  if (!req.user?.emailVerified) throw ApiError.forbidden('Email verification required');
  next();
};

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

  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const key  = await prisma.apiKey.findFirst({
    where:   { keyHash: hash, active: true },
    include: { user: { select: USER_PUBLIC } }
  });

  if (!key)                                            throw ApiError.unauthorized('Invalid API key');
  if (key.expiresAt && key.expiresAt < new Date())    throw ApiError.unauthorized('API key expired');
  if (!key.user || key.user.status !== 'active')      throw ApiError.forbidden('User account inactive');

  // Fire-and-forget usage stats
  prisma.apiKey.update({
    where: { id: key.id },
    data:  { usageCount: { increment: 1 }, lastUsedAt: new Date(), lastUsedIp: req.ip }
  }).catch(() => {});

  req.user   = key.user;
  req.userId = key.user.id;
  req.apiKey = key;
  next();
});

module.exports = { protect, requireEmailVerified, requireRole, apiKeyAuth };
