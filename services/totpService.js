/**
 * TOTP / 2FA service — speakeasy + QR generation
 */
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');
const env = require('../config/env');

const generateSecret = (email) => {
  const secret = speakeasy.generateSecret({
    name: `${env.appName} (${email})`,
    issuer: env.appName,
    length: 32
  });
  return { ascii: secret.ascii, base32: secret.base32, otpauthUrl: secret.otpauth_url };
};

const generateQRCode = (otpauthUrl) =>
  QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 2, color: { dark: '#7C3AED', light: '#000000' } });

const verifyToken = (secret, token) =>
  speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 1 });

const generateBackupCodes = (count = 10) => {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
};

const hashBackupCode = (code) =>
  crypto.createHash('sha256').update(code).digest('hex');

const verifyBackupCode = (hashedCodes, code) => {
  const hashed = hashBackupCode(code);
  const index = hashedCodes.indexOf(hashed);
  return index !== -1 ? index : -1;
};

const generateEmailOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

module.exports = {
  generateSecret,
  generateQRCode,
  verifyToken,
  generateBackupCodes,
  hashBackupCode,
  verifyBackupCode,
  generateEmailOTP
};
