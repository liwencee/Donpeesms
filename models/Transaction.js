/**
 * Transaction model — all wallet inflows/outflows (top-ups, purchases, refunds, referral payouts)
 */
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  type: {
    type: String,
    enum: ['topup','purchase','refund','referral_payout','admin_adjustment'],
    required: true
  },

  amount: { type: Number, required: true },        // signed: + credit, - debit
  currency: { type: String, default: 'USD' },
  balanceAfter: { type: Number, required: true },

  // ── Payment method (for top-ups) ──
  method: {
    type: String,
    enum: ['stripe','paypal','nowpayments','wallet','bonus','manual','system'],
    required: true
  },

  // ── External references ──
  externalId: { type: String, index: true }, // Stripe paymentIntent, NowPayments payment_id, etc.
  externalStatus: String,

  // ── Related order (for purchases/refunds) ──
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },

  // ── Crypto-specific ──
  cryptoCurrency: String,
  cryptoAmount: Number,
  cryptoAddress: String,
  cryptoTxHash: String,

  // ── Bonus ──
  bonusAmount: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['pending','processing','success','failed','cancelled'],
    default: 'pending',
    index: true
  },

  description: String,
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

  ipAddress: String,
  userAgent: String
}, { timestamps: true });

transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ externalId: 1 }, { sparse: true });

transactionSchema.statics.generateTxId = function() {
  return 'TX' + Date.now() + Math.floor(Math.random() * 1000);
};

module.exports = mongoose.model('Transaction', transactionSchema);
