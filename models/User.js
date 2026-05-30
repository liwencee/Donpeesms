/**
 * User model — auth, 2FA, profile, role
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const env = require('../config/env');

const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true, trim: true, maxlength: 50 },
  lastName:  { type: String, required: true, trim: true, maxlength: 50 },
  username:  { type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 3, maxlength: 30, match: /^[a-z0-9_]+$/ },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  password:  { type: String, required: true, minlength: 8, select: false },

  role:      { type: String, enum: ['user','admin','support'], default: 'user' },
  status:    { type: String, enum: ['active','suspended','banned'], default: 'active' },

  // ── Email verification ──
  emailVerified:           { type: Boolean, default: false },
  emailVerificationToken:  { type: String, select: false },
  emailVerificationExpires:{ type: Date, select: false },

  // ── Password reset ──
  passwordResetToken:   { type: String, select: false },
  passwordResetExpires: { type: Date, select: false },
  passwordChangedAt:    { type: Date, select: false },

  // ── 2FA (TOTP) ──
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret:  { type: String, select: false },
  twoFactorBackupCodes: [{ type: String, select: false }],

  // ── Wallet (reference) ──
  walletBalance: { type: Number, default: 0, min: 0 },

  // ── Referral ──
  referralCode:    { type: String, unique: true, sparse: true },
  referredBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  referralEarnings:{ type: Number, default: 0 },

  // ── Profile ──
  telegram: { type: String, trim: true },
  avatarUrl:{ type: String },

  // ── Security ──
  lastLogin:    { type: Date },
  lastLoginIp:  { type: String },
  loginAttempts:{ type: Number, default: 0 },
  lockUntil:    { type: Date }
}, { timestamps: true });

// ── INDEXES ──
userSchema.index({ email: 1 });
userSchema.index({ username: 1 });
userSchema.index({ referralCode: 1 });
userSchema.index({ createdAt: -1 });

// ── PASSWORD HASHING ──
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, env.bcryptRounds);
  if (!this.isNew) this.passwordChangedAt = Date.now() - 1000;
  next();
});

// ── REFERRAL CODE GENERATION ──
userSchema.pre('save', function(next) {
  if (this.isNew && !this.referralCode) {
    this.referralCode = (this.username + crypto.randomBytes(2).toString('hex')).toLowerCase();
  }
  next();
});

// ── METHODS ──
userSchema.methods.comparePassword = function(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.createEmailVerifyToken = function() {
  const token = crypto.randomBytes(32).toString('hex');
  this.emailVerificationToken = crypto.createHash('sha256').update(token).digest('hex');
  this.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24h
  return token;
};

userSchema.methods.createPasswordResetToken = function() {
  const token = crypto.randomBytes(32).toString('hex');
  this.passwordResetToken = crypto.createHash('sha256').update(token).digest('hex');
  this.passwordResetExpires = Date.now() + 30 * 60 * 1000; // 30 min
  return token;
};

userSchema.methods.isLocked = function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

userSchema.methods.incrementLoginAttempts = async function() {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    this.loginAttempts = 1;
    this.lockUntil = undefined;
  } else {
    this.loginAttempts += 1;
    if (this.loginAttempts >= 5) {
      this.lockUntil = Date.now() + 30 * 60 * 1000; // lock 30 min
    }
  }
  return this.save({ validateBeforeSave: false });
};

userSchema.methods.resetLoginAttempts = async function() {
  this.loginAttempts = 0;
  this.lockUntil = undefined;
  return this.save({ validateBeforeSave: false });
};

userSchema.methods.toSafeJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.twoFactorSecret;
  delete obj.twoFactorBackupCodes;
  delete obj.emailVerificationToken;
  delete obj.passwordResetToken;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
