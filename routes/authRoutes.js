/**
 * Auth routes — /api/auth/*
 */
const router = require('express').Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const c = require('../controllers/authController');

// Validators
const registerRules = [
  body('firstName').trim().isLength({ min: 1, max: 50 }).withMessage('First name required'),
  body('lastName').trim().isLength({ min: 1, max: 50 }).withMessage('Last name required'),
  body('username').trim().isLength({ min: 3, max: 30 }).matches(/^[a-zA-Z0-9_]+$/).withMessage('Username: 3-30 chars, alphanumeric + underscore'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password min 8 chars')
    .matches(/[a-z]/).withMessage('Password must contain lowercase')
    .matches(/[A-Z]/).withMessage('Password must contain uppercase')
    .matches(/[0-9]/).withMessage('Password must contain a number'),
  body('referralCode').optional().trim().isLength({ max: 40 })
];

const loginRules = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  body('totpCode').optional().isLength({ min: 6, max: 8 })
];

const forgotRules     = [body('email').isEmail().normalizeEmail()];
const resetRules      = [body('token').notEmpty(), body('password').isLength({ min: 8 })];
const changePassRules = [body('currentPassword').notEmpty(), body('newPassword').isLength({ min: 8 })];

// ── PUBLIC ──
router.post('/register',          authLimiter, registerRules, validate, c.register);
router.post('/login',             authLimiter, loginRules, validate, c.login);
router.post('/refresh',           c.refresh);
router.post('/logout',            c.logout);
router.post('/verify-email',      c.verifyEmail);
router.post('/forgot-password',   authLimiter, forgotRules, validate, c.forgotPassword);
router.post('/reset-password',    authLimiter, resetRules, validate, c.resetPassword);

// ── PROTECTED ──
router.get('/me',                       protect, c.me);
router.post('/resend-verification',     protect, c.resendVerification);
router.post('/change-password',         protect, changePassRules, validate, c.changePassword);
router.post('/2fa/setup',               protect, c.setup2FA);
router.post('/2fa/verify',              protect, c.verify2FA);
router.post('/2fa/disable',             protect, c.disable2FA);

module.exports = router;
