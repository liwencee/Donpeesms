/**
 * JWT helpers — sign + verify access & refresh tokens
 */
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const signAccessToken = (payload) =>
  jwt.sign(payload, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
    issuer: env.appName
  });

const signRefreshToken = (payload) =>
  jwt.sign(payload, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpiresIn,
    issuer: env.appName
  });

const verifyAccessToken = (token) => jwt.verify(token, env.jwt.secret);
const verifyRefreshToken = (token) => jwt.verify(token, env.jwt.refreshSecret);

const generateTokenPair = (user) => {
  // Prisma uses `id` (UUID string) — no .toString() needed but safe to keep
  const payload = { id: user.id, email: user.email, role: user.role };
  return {
    accessToken:  signAccessToken(payload),
    refreshToken: signRefreshToken({ id: user.id })
  };
};

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  generateTokenPair
};
