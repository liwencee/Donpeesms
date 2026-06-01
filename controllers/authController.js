/**
 * Auth controller — register, login, refresh, logout, email verify, password reset, 2FA
 */
const crypto = require('crypto');
const { prisma } = require('../config/db');
const {
  hashPassword, comparePassword, generateReferralCode,
  createEmailVerifyToken, createPasswordResetToken,
  isLocked, incrementLoginAttempts, resetLoginAttempts,
  toSafeJSON,
  USER_PUBLIC, USER_WITH_AUTH, USER_WITH_2FA,
  USER_WITH_EMAIL_VERIFY, USER_WITH_PASSWORD_RESET, USER_WITH_PASSWORD
} = require('../models/User');
const ApiError       = require('../utils/apiError');
const asyncHandler   = require('../utils/asyncHandler');
const { generateTokenPair, verifyRefreshToken } = require('../utils/jwt');
const email          = require('../services/emailService');
const totp           = require('../services/totpService');
const env            = require('../config/env');
const logger         = require('../utils/logger');

// ── COOKIES ──
const accessCookie = {
  httpOnly: true,
  secure:   env.env === 'production',
  sameSite: env.env === 'production' ? 'none' : 'lax',
  maxAge:   7 * 24 * 60 * 60 * 1000
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
    user: toSafeJSON(user)
  });
};

// ═════════════════════════════════════════════
// POST /api/auth/register
// ═════════════════════════════════════════════
exports.register = asyncHandler(async (req, res) => {
  const { firstName, lastName, username, email: userEmail, password, referralCode } = req.body;

  // Check uniqueness
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: userEmail.toLowerCase() }, { username: username.toLowerCase() }] }
  });
  if (existing) {
    throw ApiError.conflict(
      existing.email === userEmail.toLowerCase() ? 'Email already registered' : 'Username taken'
    );
  }

  // Find referrer
  let referrer = null;
  if (referralCode) {
    referrer = await prisma.user.findFirst({ where: { referralCode: referralCode.toLowerCase() } });
  }

  // Prepare tokens before insert
  const { token: verifyToken, hashed: verifyHashed, expires: verifyExpires } = createEmailVerifyToken();
  const hashedPassword = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      firstName,
      lastName,
      username:                username.toLowerCase(),
      email:                   userEmail.toLowerCase(),
      password:                hashedPassword,
      referredById:            referrer?.id,
      referralCode:            generateReferralCode(username.toLowerCase()),
      emailVerificationToken:  verifyHashed,
      emailVerificationExpires: verifyExpires,
      walletBalance:           0.10  // welcome credit
    },
    select: USER_PUBLIC
  });

  // Welcome bonus transaction
  await prisma.transaction.create({
    data: {
      userId:      user.id,
      type:        'admin_adjustment',
      amount:      0.10,
      balanceAfter: 0.10,
      method:      'bonus',
      status:      'success',
      description: 'Welcome bonus'
    }
  });

  // Verification email (async, non-blocking)
  email.sendVerificationEmail(user, verifyToken)
    .catch(err => logger.error('Verify email send failed:', err.message));

  logger.info(`New user registered: ${user.email} (referred by: ${referrer?.username || 'none'})`);
  sendAuthResponse(res, user, { newUser: true });
});

// ═════════════════════════════════════════════
// POST /api/auth/login
// ═════════════════════════════════════════════
exports.login = asyncHandler(async (req, res) => {
  const { email: userEmail, password, totpCode } = req.body;

  // Fetch with all auth fields
  const userWithAuth = await prisma.user.findFirst({
    where:  { email: userEmail.toLowerCase() },
    select: USER_WITH_AUTH
  });

  if (!userWithAuth) throw ApiError.unauthorized('Invalid credentials');
  if (isLocked(userWithAuth)) throw ApiError.forbidden(`Account locked until ${userWithAuth.lockUntil.toISOString()}`);
  if (userWithAuth.status !== 'active') throw ApiError.forbidden(`Account ${userWithAuth.status}`);

  const valid = await comparePassword(userWithAuth.password, password);
  if (!valid) {
    await incrementLoginAttempts(userWithAuth);
    throw ApiError.unauthorized('Invalid credentials');
  }

  // 2FA check
  if (userWithAuth.twoFactorEnabled) {
    if (!totpCode) {
      return res.status(200).json({
        success: true,
        twoFactorRequired: true,
        message: 'Enter your 2FA code'
      });
    }

    const ok = totp.verifyToken(userWithAuth.twoFactorSecret, totpCode);
    if (!ok) {
      const idx = totp.verifyBackupCode(userWithAuth.twoFactorBackupCodes, totpCode);
      if (idx === -1) {
        await incrementLoginAttempts(userWithAuth);
        throw ApiError.unauthorized('Invalid 2FA code');
      }
      // Consume backup code
      const updatedCodes = [...userWithAuth.twoFactorBackupCodes];
      updatedCodes.splice(idx, 1);
      await prisma.user.update({
        where: { id: userWithAuth.id },
        data:  { twoFactorBackupCodes: updatedCodes }
      });
    }
  }

  // Success — update login metadata and reset lockout
  const user = await prisma.user.update({
    where:  { id: userWithAuth.id },
    data:   { loginAttempts: 0, lockUntil: null, lastLogin: new Date(), lastLoginIp: req.ip },
    select: USER_PUBLIC
  });

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

  const user = await prisma.user.findUnique({ where: { id: decoded.id }, select: USER_PUBLIC });
  if (!user || user.status !== 'active') throw ApiError.unauthorized('User invalid');

  const { accessToken, refreshToken: newRefresh } = generateTokenPair(user);
  res.cookie('accessToken', accessToken, accessCookie);
  res.cookie('refreshToken', newRefresh, refreshCookie);
  res.json({ success: true, accessToken, refreshToken: newRefresh });
});

// ═════════════════════════════════════════════
// POST /api/auth/logout
// ═════════════════════════════════════════════
exports.logout = asyncHandler(async (_req, res) => {
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken', { path: '/api/auth' });
  res.json({ success: true, message: 'Logged out' });
});

// ═════════════════════════════════════════════
// GET /api/auth/me
// ═════════════════════════════════════════════
exports.me = asyncHandler(async (req, res) => {
  res.json({ success: true, user: toSafeJSON(req.user) });
});

// ═════════════════════════════════════════════
// POST /api/auth/verify-email
// ═════════════════════════════════════════════
exports.verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) throw ApiError.badRequest('Token required');

  const hashed = crypto.createHash('sha256').update(token).digest('hex');

  const user = await prisma.user.findFirst({
    where: {
      emailVerificationToken:   hashed,
      emailVerificationExpires: { gt: new Date() }
    },
    select: USER_WITH_EMAIL_VERIFY
  });
  if (!user) throw ApiError.badRequest('Invalid or expired verification token');

  await prisma.user.update({
    where: { id: user.id },
    data:  { emailVerified: true, emailVerificationToken: null, emailVerificationExpires: null }
  });

  res.json({ success: true, message: 'Email verified' });
});

// ═════════════════════════════════════════════
// POST /api/auth/resend-verification
// ═════════════════════════════════════════════
exports.resendVerification = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: USER_WITH_EMAIL_VERIFY });
  if (user.emailVerified) throw ApiError.badRequest('Already verified');

  const { token, hashed, expires } = createEmailVerifyToken();
  await prisma.user.update({
    where: { id: user.id },
    data:  { emailVerificationToken: hashed, emailVerificationExpires: expires }
  });

  email.sendVerificationEmail(user, token)
    .catch(err => logger.error('Resend verify:', err.message));

  res.json({ success: true, message: 'Verification email sent' });
});

// ═════════════════════════════════════════════
// POST /api/auth/forgot-password
// ═════════════════════════════════════════════
exports.forgotPassword = asyncHandler(async (req, res) => {
  const user = await prisma.user.findFirst({ where: { email: req.body.email.toLowerCase() } });
  // Always return success — don't reveal which emails exist
  if (!user) return res.json({ success: true, message: 'If account exists, reset link sent' });

  const { token, hashed, expires } = createPasswordResetToken();
  await prisma.user.update({
    where: { id: user.id },
    data:  { passwordResetToken: hashed, passwordResetExpires: expires }
  });

  await email.sendPasswordResetEmail(user, token)
    .catch(err => logger.error('Reset email:', err.message));

  res.json({ success: true, message: 'If account exists, reset link sent' });
});

// ═════════════════════════════════════════════
// POST /api/auth/reset-password
// ═════════════════════════════════════════════
exports.resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  const hashed = crypto.createHash('sha256').update(token).digest('hex');

  const user = await prisma.user.findFirst({
    where: {
      passwordResetToken:   hashed,
      passwordResetExpires: { gt: new Date() }
    },
    select: USER_WITH_PASSWORD_RESET
  });
  if (!user) throw ApiError.badRequest('Invalid or expired reset token');

  await prisma.user.update({
    where: { id: user.id },
    data:  {
      password:            await hashPassword(password),
      passwordResetToken:  null,
      passwordResetExpires: null,
      passwordChangedAt:   new Date()
    }
  });

  res.json({ success: true, message: 'Password reset successful' });
});

// ═════════════════════════════════════════════
// POST /api/auth/change-password
// ═════════════════════════════════════════════
exports.changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = await prisma.user.findUnique({
    where:  { id: req.userId },
    select: USER_WITH_PASSWORD
  });

  const ok = await comparePassword(user.password, currentPassword);
  if (!ok) throw ApiError.unauthorized('Current password incorrect');

  await prisma.user.update({
    where: { id: req.userId },
    data:  { password: await hashPassword(newPassword), passwordChangedAt: new Date() }
  });

  res.json({ success: true, message: 'Password changed' });
});

// ═════════════════════════════════════════════
// POST /api/auth/2fa/setup
// ═════════════════════════════════════════════
exports.setup2FA = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: USER_WITH_2FA });
  if (user.twoFactorEnabled) throw ApiError.badRequest('2FA already enabled');

  const { base32, otpauthUrl } = totp.generateSecret(user.email);
  const qrCode = await totp.generateQRCode(otpauthUrl);

  // Save secret temporarily (not enabled until verified)
  await prisma.user.update({
    where: { id: user.id },
    data:  { twoFactorSecret: base32 }
  });

  res.json({ success: true, secret: base32, qrCode, otpauthUrl });
});

// ═════════════════════════════════════════════
// POST /api/auth/2fa/verify
// ═════════════════════════════════════════════
exports.verify2FA = asyncHandler(async (req, res) => {
  const { token } = req.body;
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: USER_WITH_2FA });

  if (!user.twoFactorSecret) throw ApiError.badRequest('Run 2FA setup first');

  const ok = totp.verifyToken(user.twoFactorSecret, token);
  if (!ok) throw ApiError.unauthorized('Invalid 2FA code');

  const backupCodes    = totp.generateBackupCodes(10);
  const hashedBackups  = backupCodes.map(totp.hashBackupCode);

  await prisma.user.update({
    where: { id: user.id },
    data:  { twoFactorEnabled: true, twoFactorBackupCodes: hashedBackups }
  });

  res.json({ success: true, message: '2FA enabled', backupCodes });
});

// ═════════════════════════════════════════════
// POST /api/auth/2fa/disable
// ═════════════════════════════════════════════
exports.disable2FA = asyncHandler(async (req, res) => {
  const { password } = req.body;

  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: USER_WITH_2FA });
  // Re-fetch with password
  const userWithPass = await prisma.user.findUnique({ where: { id: req.userId }, select: { password: true } });

  const ok = await comparePassword(userWithPass.password, password);
  if (!ok) throw ApiError.unauthorized('Password incorrect');

  await prisma.user.update({
    where: { id: user.id },
    data:  { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: [] }
  });

  res.json({ success: true, message: '2FA disabled' });
});
