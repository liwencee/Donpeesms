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
  const payload = { id: user._id.toString(), email: user.email, role: user.role };
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken({ id: user._id.toString() })
  };
};

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  generateTokenPair
};
