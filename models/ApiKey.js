/**
 * ApiKey helpers
 * Controllers use prisma.apiKey directly; import helpers from here.
 */
const crypto = require('crypto');
const { prisma } = require('../config/db');

const generateKey = () => {
  const raw    = 'dps_live_' + crypto.randomBytes(24).toString('hex');
  const hash   = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.substring(0, 16);
  return { raw, hash, prefix };
};

const findByKey = (rawKey) => {
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  return prisma.apiKey.findFirst({
    where:   { keyHash: hash, active: true },
    include: { user: true }
  });
};

module.exports = { generateKey, findByKey };
