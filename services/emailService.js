/**
 * Email service — Nodemailer wrapper with branded HTML templates
 */
const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('../utils/logger');

let transporter = null;

const initTransporter = () => {
  if (transporter) return transporter;

  if (!env.smtp.host || !env.smtp.user) {
    logger.warn('SMTP not configured — emails will be logged to console only');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: { user: env.smtp.user, pass: env.smtp.pass }
  });

  transporter.verify((err) => {
    if (err) logger.error('SMTP verification failed:', err.message);
    else logger.info('✓ SMTP ready');
  });

  return transporter;
};

const baseTemplate = (title, bodyHTML) => `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>${title}</title></head>
<body style="margin:0;padding:0;background:#000000;font-family:Arial,sans-serif;color:#F8FAFC">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="display:inline-block;width:48px;height:48px;background:linear-gradient(135deg,#5B21B6,#8B5CF6);border-radius:12px;line-height:48px;text-align:center;color:white;font-size:20px;font-weight:bold">N</div>
      <div style="margin-top:10px;font-size:20px;font-weight:bold;background:linear-gradient(135deg,#A78BFA,#C4B5FD);-webkit-background-clip:text;-webkit-text-fill-color:transparent">DonPeeSMS</div>
    </div>
    <div style="background:#0D0D1F;border:1px solid #1E1B4B;border-radius:16px;padding:36px 28px">
      ${bodyHTML}
    </div>
    <div style="text-align:center;margin-top:24px;font-size:12px;color:#64748B">
      &copy; ${new Date().getFullYear()} DonPeeSMS. All rights reserved.<br>
      <a href="${env.frontendUrl}" style="color:#A78BFA">donpeesms.com</a>
    </div>
  </div>
</body></html>`;

const send = async ({ to, subject, html, text }) => {
  const t = initTransporter();
  if (!t) {
    logger.info(`[EMAIL DEV] To: ${to} | Subject: ${subject}\n${text || html}`);
    return { mocked: true };
  }

  const info = await t.sendMail({
    from: `"${env.smtp.fromName}" <${env.smtp.fromEmail || env.smtp.user}>`,
    to,
    subject,
    html,
    text: text || subject
  });

  logger.info(`Email sent to ${to}: ${info.messageId}`);
  return info;
};

const sendVerificationEmail = (user, token) => {
  const url = `${env.frontendUrl}/verify-email?token=${token}`;
  const body = `
    <h1 style="font-size:22px;margin:0 0 16px;color:#F8FAFC">Verify your email</h1>
    <p style="color:#CBD5E1;line-height:1.7;margin-bottom:24px">Hi ${user.firstName}, welcome to DonPeeSMS! Please verify your email to start using your account.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#5B21B6,#8B5CF6);color:white;padding:14px 32px;border-radius:9999px;text-decoration:none;font-weight:bold">Verify Email</a>
    </div>
    <p style="color:#64748B;font-size:13px;line-height:1.6">Or copy this link: <a href="${url}" style="color:#A78BFA;word-break:break-all">${url}</a></p>
    <p style="color:#64748B;font-size:12px;margin-top:24px">This link expires in 24 hours.</p>
  `;
  return send({ to: user.email, subject: 'Verify your DonPeeSMS email', html: baseTemplate('Verify Email', body) });
};

const sendPasswordResetEmail = (user, token) => {
  const url = `${env.frontendUrl}/reset-password?token=${token}`;
  const body = `
    <h1 style="font-size:22px;margin:0 0 16px">Reset your password</h1>
    <p style="color:#CBD5E1;line-height:1.7;margin-bottom:24px">We received a request to reset your password. Click below to choose a new one.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#5B21B6,#8B5CF6);color:white;padding:14px 32px;border-radius:9999px;text-decoration:none;font-weight:bold">Reset Password</a>
    </div>
    <p style="color:#64748B;font-size:13px">If you didn't request this, ignore this email. The link expires in 30 minutes.</p>
  `;
  return send({ to: user.email, subject: 'Reset your DonPeeSMS password', html: baseTemplate('Reset Password', body) });
};

const send2FACode = (user, code) => {
  const body = `
    <h1 style="font-size:22px;margin:0 0 16px">Your verification code</h1>
    <p style="color:#CBD5E1;margin-bottom:24px">Use this code to complete sign-in:</p>
    <div style="text-align:center;margin:28px 0">
      <div style="display:inline-block;background:#12122A;border:1px solid #4C1D95;padding:18px 32px;border-radius:12px;font-size:32px;letter-spacing:8px;color:#A78BFA;font-weight:bold">${code}</div>
    </div>
    <p style="color:#64748B;font-size:13px">This code expires in 10 minutes. Never share it with anyone.</p>
  `;
  return send({ to: user.email, subject: `DonPeeSMS code: ${code}`, html: baseTemplate('2FA Code', body) });
};

const sendOrderConfirmation = (user, order) => {
  const body = `
    <h1 style="font-size:22px;margin:0 0 16px">Your number is ready</h1>
    <p style="color:#CBD5E1;margin-bottom:24px">Order <b>${order.orderId}</b> is now active.</p>
    <div style="background:#12122A;border:1px solid #4C1D95;padding:18px;border-radius:12px;margin-bottom:20px">
      <div style="font-size:12px;color:#64748B;text-transform:uppercase;margin-bottom:6px">Phone Number</div>
      <div style="font-size:22px;color:#C4B5FD;font-weight:bold">${order.phoneNumber}</div>
    </div>
    <p style="color:#94A3B8;font-size:14px">Service: ${order.serviceType.toUpperCase()} · Country: ${order.country} · Cost: $${order.userCost.toFixed(2)}</p>
  `;
  return send({ to: user.email, subject: `Order ${order.orderId} active`, html: baseTemplate('Order Active', body) });
};

const sendTopupConfirmation = (user, tx) => {
  const body = `
    <h1 style="font-size:22px;margin:0 0 16px">Wallet topped up</h1>
    <p style="color:#CBD5E1">Hi ${user.firstName}, your top-up was successful.</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0">
      <tr><td style="padding:10px;border-bottom:1px solid #1E1B4B;color:#64748B">Amount</td><td style="padding:10px;border-bottom:1px solid #1E1B4B;text-align:right;color:#34D399;font-weight:bold">+$${tx.amount.toFixed(2)}</td></tr>
      ${tx.bonusAmount > 0 ? `<tr><td style="padding:10px;border-bottom:1px solid #1E1B4B;color:#64748B">Bonus</td><td style="padding:10px;border-bottom:1px solid #1E1B4B;text-align:right;color:#34D399">+$${tx.bonusAmount.toFixed(2)}</td></tr>` : ''}
      <tr><td style="padding:10px;color:#64748B">New balance</td><td style="padding:10px;text-align:right;color:#A78BFA;font-weight:bold">$${tx.balanceAfter.toFixed(2)}</td></tr>
    </table>
  `;
  return send({ to: user.email, subject: 'Top-up confirmed', html: baseTemplate('Top-up', body) });
};

module.exports = {
  send,
  sendVerificationEmail,
  sendPasswordResetEmail,
  send2FACode,
  sendOrderConfirmation,
  sendTopupConfirmation
};
