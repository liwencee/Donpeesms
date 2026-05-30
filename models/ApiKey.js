/**
 * API Key model — for developers using REST API
 */
const mongoose = require('mongoose');
const crypto = require('crypto');

const apiKeySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, maxlength: 50 },

  keyPrefix: { type: String, required: true, index: true },  // displayed: dps_live_abc...
  keyHash:   { type: String, required: true, select: false }, // sha256 of full key

  scopes: [{ type: String, enum: ['read','write','admin'] }],

  lastUsedAt: Date,
  lastUsedIp: String,
  usageCount: { type: Number, default: 0 },

  active: { type: Boolean, default: true },
  expiresAt: Date
}, { timestamps: true });

apiKeySchema.statics.generateKey = function() {
  const raw = 'dps_live_' + crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash, prefix: raw.substring(0, 16) };
};

apiKeySchema.statics.findByKey = function(rawKey) {
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  return this.findOne({ keyHash: hash, active: true });
};

module.exports = mongoose.model('ApiKey', apiKeySchema);
