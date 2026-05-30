/**
 * Order model — a single number purchase (WhatsApp / SMS)
 */
const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  orderId: { type: String, unique: true, required: true, index: true },

  // ── Provider ──
  provider: { type: String, enum: ['fivesim','smsactivate','twilio','manual'], required: true },
  providerOrderId: { type: String, index: true },

  // ── Service ──
  serviceType: { type: String, enum: ['whatsapp','sms'], required: true },
  service: String,        // e.g. "telegram", "google", "any"
  country: { type: String, required: true, uppercase: true, maxlength: 4 },
  operator: String,

  // ── Number ──
  phoneNumber: { type: String, required: true, index: true },

  // ── Pricing ──
  providerCost: { type: Number, required: true },  // what we pay
  userCost:     { type: Number, required: true },  // what user pays
  currency:     { type: String, default: 'USD' },

  // ── SMS / OTP ──
  smsMessages: [{
    text: String,
    sender: String,
    code: String,
    receivedAt: Date
  }],
  otpCode: { type: String, index: true },

  // ── Status ──
  status: {
    type: String,
    enum: ['pending','active','received','expired','cancelled','refunded','failed'],
    default: 'pending',
    index: true
  },

  // ── Lifecycle ──
  expiresAt: Date,
  activatedAt: Date,
  completedAt: Date,
  cancelledAt: Date,
  refundedAt: Date,

  // ── Refund ──
  refundReason: String,
  refundTx: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },

  // ── Audit ──
  ipAddress: String,
  userAgent: String,
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1, expiresAt: 1 });
orderSchema.index({ provider: 1, providerOrderId: 1 });

orderSchema.statics.generateOrderId = function() {
  return 'NV' + Math.floor(100000 + Math.random() * 900000) + Date.now().toString().slice(-4);
};

orderSchema.virtual('timeRemaining').get(function() {
  if (!this.expiresAt) return null;
  return Math.max(0, this.expiresAt - Date.now());
});

orderSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);
