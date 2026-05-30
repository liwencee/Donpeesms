/**
 * Auth controller — register, login, refresh, logout, email verify, password reset, 2FA
 */
const crypto = require('crypto');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { generateTokenPair, verifyRefreshToken } = require('../utils/jwt');
const email = require('../services/emailService');
const totp = require('../services/totpService');
const env = require('../config/env');
const logger = require('../utils/logger');

// ── COOKIES ──
const accessCookie = {
  httpOnly: true,
  secure: env.env === 'production',
  sameSite: env.env === 'production' ? 'none' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000
};
const refreshCookie = { ...accessCookie, maxAge: 30 * 24 * 60 * 60 * 1000, path: '/api/auth' };

const sendAuthResponse = (res, user, { newUser = false } = {}) => {
  const { accessToken, refreshToken } = generateTokenPair(user);
  res.cookie('accessToken', accessToken, accessCookie);
  res.cookie('refreshToken', refreshToken, refreshCookie);
  res.status(newUser ? 201 : 200).json({
    success: true,
    message: newUser ? 'Account created' : 'Logged in',
    accessToken,
    refreshToken,
    user: user.toSafeJSON()
  });
};

// ═════════════════════════════════════════════
// POST /api/auth/register
// ═════════════════════════════════════════════
exports.register = asyncHandler(async (req, res) => {
  const { firstName, lastName, username, email: userEmail, password, referralCode } = req.body;

  // Check uniqueness
  const existing = await User.findOne({ $or: [{ email: userEmail.toLowerCase() }, { username: username.toLowerCase() }] });
  if (existing) {
    throw ApiError.conflict(existing.email === userEmail.toLowerCase() ? 'Email already registered' : 'Username taken');
  }

  // Find referrer
  let referrer = null;
  if (referralCode) {
    referrer = await User.findOne({ referralCode: referralCode.toLowerCase() });
  }

  const user = new User({
    firstName,
    lastName,
    username: username.toLowerCase(),
    email: userEmail.toLowerCase(),
    password,
    referredBy: referrer?._id
  });

  // Email verification token
  const verifyToken = user.createEmailVerifyToken();
  await user.save();

  // Send verification email (async, don't block)
  email.sendVerificationEmail(user, verifyToken).catch(err => logger.error('Verify email send failed:', err.message));

  // Sign-up bonus
  user.walletBalance = 0.10; // $0.10 welcome credit
  await user.save();

  await Transaction.create({
    user: user._id,
    type: 'admin_adjustment',
    amount: 0.10,
    balanceAfter: 0.10,
    method: 'bonus',
    status: 'success',
    description: 'Welcome bonus'
  });

  logger.info(`New user registered: ${user.email} (referred by: ${referrer?.username || 'none'})`);
  sendAuthResponse(res, user, { newUser: true });
});

// ═════════════════════════════════════════════
// POST /api/auth/login
// ═════════════════════════════════════════════
exports.login = asyncHandler(async (req, res) => {
  const { email: userEmail, password, totpCode } = req.body;

  const user = await User.findOne({ email: userEmail.toLowerCase() })
    .select('+password +twoFactorSecret +twoFactorBackupCodes');

  if (!user) throw ApiError.unauthorized('Invalid credentials');
  if (user.isLocked()) throw ApiError.forbidden(`Account locked until ${user.lockUntil.toISOString()}`);
  if (user.status !== 'active') throw ApiError.forbidden(`Account ${user.status}`);

  const valid = await user.comparePassword(password);
  if (!valid) {
    await user.incrementLoginAttempts();
    throw ApiError.unauthorized('Invalid credentials');
  }

  // 2FA check
  if (user.twoFactorEnabled) {
    if (!totpCode) {
      return res.status(200).json({
        success: true,
        twoFactorRequired: true,
        message: 'Enter your 2FA code'
      });
    }

    const ok = totp.verifyToken(user.twoFactorSecret, totpCode);
    let backupUsed = false;
    if (!ok) {
      const idx = totp.verifyBackupCode(user.twoFactorBackupCodes, totpCode);
      if (idx === -1) {
        await user.incrementLoginAttempts();
        throw ApiError.unauthorized('Invalid 2FA code');
      }
      // Consume backup code
      user.twoFactorBackupCodes.splice(idx, 1);
      backupUsed = true;
    }

    if (backupUsed) await user.save();
  }

  await user.resetLoginAttempts();
  user.lastLogin = new Date();
  user.lastLoginIp = req.ip;
  await user.save({ validateBeforeSave: false });

  logger.info(`User login: ${user.email}`);
  sendAuthResponse(res, user);
});

// ═════════════════════════════════════════════
// POST /api/auth/refresh
// ═════════════════════════════════════════════
exports.refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body.refreshToken;
  if (!token) throw ApiError.unauthorized('Refresh token required');

  let decoded;
  try { decoded = verifyRefreshToken(token); }
  catch { throw ApiError.unauthorized('Invalid refresh token'); }

  const user = await User.findById(decoded.id);
  if (!user || user.status !== 'active') throw ApiError.unauthorized('User invalid');

  const { accessToken, refreshToken: newRefresh } = generateTokenPair(user);
  res.cookie('accessToken', accessToken, accessCookie);
  res.cookie('refreshToken', newRefresh, refreshCookie);
  res.json({ success: true, accessToken, refreshToken: newRefresh });
});

// ═════════════════════════════════════════════
// POST /api/auth/logout
// ═════════════════════════════════════════════
exports.logout = asyncHandler(async (req, res) => {
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken', { path: '/api/auth' });
  res.json({ success: true, message: 'Logged out' });
});

// ═════════════════════════════════════════════
// GET /api/auth/me
// ═════════════════════════════════════════════
exports.me = asyncHandler(async (req, res) => {
  res.json({ success: true, user: req.user.toSafeJSON() });
});

// ═════════════════════════════════════════════
// POST /api/auth/verify-email
// ═════════════════════════════════════════════
exports.verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) throw ApiError.badRequest('Token required');

  const hashed = crypto.createHash('sha256').update(token).digest('hex');
  const user = await User.findOne({
    emailVerificationToken: hashed,
    emailVerificationExpires: { $gt: Date.now() }
  }).select('+emailVerificationToken +emailVerificationExpires');

  if (!user) throw ApiError.badRequest('Invalid or expired verification token');

  user.emailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();

  res.json({ success: true, message: 'Email verified' });
});

// ═════════════════════════════════════════════
// POST /api/auth/resend-verification
// ═════════════════════════════════════════════
exports.resendVerification = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('+emailVerificationToken');
  if (user.emailVerified) throw ApiError.badRequest('Already verified');

  const token = user.createEmailVerifyToken();
  await user.save();
  email.sendVerificationEmail(user, token).catch(err => logger.error('Resend verify:', err.message));

  res.json({ success: true, message: 'Verification email sent' });
});

// ═════════════════════════════════════════════
// POST /api/auth/forgot-password
// ═════════════════════════════════════════════
exports.forgotPassword = asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase() });
  // Always return success (don't reveal which emails exist)
  if (!user) return res.json({ success: true, message: 'If account exists, reset link sent' });

  const token = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  await email.sendPasswordResetEmail(user, token).catch(err => logger.error('Reset email:', err.message));
  res.json({ success: true, message: 'If account exists, reset link sent' });
});

// ═════════════════════════════════════════════
// POST /api/auth/reset-password
// ═════════════════════════════════════════════
exports.resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  const hashed = crypto.createHash('sha256').update(token).digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashed,
    passwordResetExpires: { $gt: Date.now() }
  }).select('+passwordResetToken +passwordResetExpires');

  if (!user) throw ApiError.badRequest('Invalid or expired reset token');

  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  res.json({ success: true, message: 'Password reset successful' });
});

// ═════════════════════════════════════════════
// POST /api/auth/change-password
// ═════════════════════════════════════════════
exports.changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.userId).select('+password');

  const ok = await user.comparePassword(currentPassword);
  if (!ok) throw ApiError.unauthorized('Current password incorrect');

  user.password = newPassword;
  await user.save();
  res.json({ success: true, message: 'Password changed' });
});

// ═════════════════════════════════════════════
// POST /api/auth/2fa/setup
// ═════════════════════════════════════════════
exports.setup2FA = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('+twoFactorSecret');
  if (user.twoFactorEnabled) throw ApiError.badRequest('2FA already enabled');

  const { base32, otpauthUrl } = totp.generateSecret(user.email);
  const qrCode = await totp.generateQRCode(otpauthUrl);

  // Save secret temporarily (not enabled until verified)
  user.twoFactorSecret = base32;
  await user.save({ validateBeforeSave: false });

  res.json({ success: true, secret: base32, qrCode, otpauthUrl });
});

// ═════════════════════════════════════════════
// POST /api/auth/2fa/verify
// ═════════════════════════════════════════════
exports.verify2FA = asyncHandler(async (req, res) => {
  const { token } = req.body;
  const user = await User.findById(req.userId).select('+twoFactorSecret +twoFactorBackupCodes');

  if (!user.twoFactorSecret) throw ApiError.badRequest('Run 2FA setup first');

  const ok = totp.verifyToken(user.twoFactorSecret, token);
  if (!ok) throw ApiError.unauthorized('Invalid 2FA code');

  // Generate backup codes
  const backupCodes = totp.generateBackupCodes(10);
  user.twoFactorBackupCodes = backupCodes.map(totp.hashBackupCode);
  user.twoFactorEnabled = true;
  await user.save();

  res.json({ success: true, message: '2FA enabled', backupCodes });
});

// ═════════════════════════════════════════════
// POST /api/auth/2fa/disable
// ═════════════════════════════════════════════
exports.disable2FA = asyncHandler(async (req, res) => {
  const { password } = req.body;
  const user = await User.findById(req.userId).select('+password +twoFactorSecret');

  const ok = await user.comparePassword(password);
  if (!ok) throw ApiError.unauthorized('Password incorrect');

  user.twoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  user.twoFactorBackupCodes = [];
  await user.save();

  res.json({ success: true, message: '2FA disabled' });
});
