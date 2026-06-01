/**
 * User helpers — password hashing, token generation, field select presets
 * All Mongoose instance/static methods are now standalone functions.
 * Controllers use prisma.user directly; import helpers from here.
 */
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const env     = require('../config/env');
const { prisma } = require('../config/db');

// ── Password ──────────────────────────────────────────────────
const hashPassword    = (password) => bcrypt.hash(password, env.bcryptRounds);
const comparePassword = (hashedPass, candidate) => bcrypt.compare(candidate, hashedPass);

// ── Referral code ─────────────────────────────────────────────
const generateReferralCode = (username) =>
  (username + crypto.randomBytes(2).toString('hex')).toLowerCase();

// ── Email verification token ──────────────────────────────────
const createEmailVerifyToken = () => {
  const token  = crypto.randomBytes(32).toString('hex');
  const hashed = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h
  return { token, hashed, expires };
};

// ── Password reset token ──────────────────────────────────────
const createPasswordResetToken = () => {
  const token  = crypto.randomBytes(32).toString('hex');
  const hashed = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
  return { token, hashed, expires };
};

// ── Lock helpers ──────────────────────────────────────────────
const isLocked = (user) => !!(user.lockUntil && user.lockUntil > new Date());

const incrementLoginAttempts = async (user) => {
  const now = new Date();
  if (user.lockUntil && user.lockUntil < now) {
    // Lock expired — reset
    return prisma.user.update({
      where: { id: user.id },
      data: { loginAttempts: 1, lockUntil: null }
    });
  }
  const newAttempts = user.loginAttempts + 1;
  const data = { loginAttempts: newAttempts };
  if (newAttempts >= 5) {
    data.lockUntil = new Date(Date.now() + 30 * 60 * 1000); // lock 30 min
  }
  return prisma.user.update({ where: { id: user.id }, data });
};

const resetLoginAttempts = (userId) =>
  prisma.user.update({ where: { id: userId }, data: { loginAttempts: 0, lockUntil: null } });

// ── Safe JSON — strips all sensitive fields ───────────────────
const toSafeJSON = (user) => {
  const obj = { ...user };
  delete obj.password;
  delete obj.twoFactorSecret;
  delete obj.twoFactorBackupCodes;
  delete obj.emailVerificationToken;
  delete obj.emailVerificationExpires;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  delete obj.passwordChangedAt;
  return obj;
};

// ── Prisma select presets ─────────────────────────────────────
// All public fields (no secrets)
const USER_PUBLIC = {
  id: true, createdAt: true, updatedAt: true,
  firstName: true, lastName: true, username: true, email: true,
  role: true, status: true,
  emailVerified: true,
  twoFactorEnabled: true,
  walletBalance: true,
  referralCode: true, referredById: true, referralEarnings: true,
  telegram: true, avatarUrl: true,
  lastLogin: true, lastLoginIp: true,
  loginAttempts: true, lockUntil: true
};

// + password (login, changePassword)
const USER_WITH_PASSWORD = { ...USER_PUBLIC, password: true };

// + 2FA fields (login with 2FA, setup2FA, verify2FA, disable2FA)
const USER_WITH_2FA = {
  ...USER_PUBLIC,
  twoFactorSecret: true,
  twoFactorBackupCodes: true
};

// + password + 2FA (login covers all)
const USER_WITH_AUTH = {
  ...USER_PUBLIC,
  password: true,
  twoFactorSecret: true,
  twoFactorBackupCodes: true
};

// + email verification fields
const USER_WITH_EMAIL_VERIFY = {
  ...USER_PUBLIC,
  emailVerificationToken: true,
  emailVerificationExpires: true
};

// + password reset fields
const USER_WITH_PASSWORD_RESET = {
  ...USER_PUBLIC,
  passwordResetToken: true,
  passwordResetExpires: true
};

module.exports = {
  hashPassword,
  comparePassword,
  generateReferralCode,
  createEmailVerifyToken,
  createPasswordResetToken,
  isLocked,
  incrementLoginAttempts,
  resetLoginAttempts,
  toSafeJSON,
  USER_PUBLIC,
  USER_WITH_PASSWORD,
  USER_WITH_2FA,
  USER_WITH_AUTH,
  USER_WITH_EMAIL_VERIFY,
  USER_WITH_PASSWORD_RESET
};
