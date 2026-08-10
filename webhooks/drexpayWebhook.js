/**
 * DrexPay webhook handler — confirms top-ups and credits wallet.
 * Endpoint must receive RAW body, not JSON-parsed (signature verification
 * needs the exact bytes DrexPay signed).
 */
const drexpay          = require('../services/drexpayService');
const { supabase }     = require('../config/supabase');
const wallet           = require('../controllers/walletController');
const email            = require('../services/emailService');
const logger           = require('../utils/logger');
const asyncHandler     = require('../utils/asyncHandler');
const { toCamelCase }  = require('../utils/caseMapper');

module.exports = asyncHandler(async (req, res) => {
  const signature = req.headers['x-drexpay-signature'];

  if (!drexpay.verifyWebhookSignature(req.body, signature)) {
    logger.warn('DrexPay webhook signature invalid');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body.toString('utf8'));
  const reference = event.data && event.data.reference;
  logger.info(`DrexPay webhook: ${event.event} → ${reference}`);

  if (!reference) return res.json({ received: true });

  const { data: pendingRow, error: findErr } = await supabase
    .from('transactions').select('*').eq('external_id', reference).eq('status', 'pending').maybeSingle();
  if (findErr) { logger.error('DrexPay webhook lookup failed:', findErr.message); return res.json({ received: true }); }
  if (!pendingRow) {
    logger.warn(`DrexPay webhook: no pending tx for reference ${reference}`);
    return res.json({ received: true });
  }
  const pending = toCamelCase(pendingRow);

  switch (event.event) {
    case 'charge.success': {
      const { user, tx } = await wallet.creditWallet({
        userId: pending.userId, amount: pending.amount, bonus: pending.bonusAmount || 0,
        externalId: reference, method: 'drexpay', description: `DrexPay top-up (₦${pending.amount})`
      });

      const { error } = await supabase.from('transactions').update({
        status: 'success', balance_after: user.walletBalance,
        metadata: { ...(pending.metadata || {}), drexpayReference: reference, fulfilledTxId: tx.id }
      }).eq('id', pending.id);
      if (error) logger.error('DrexPay webhook: failed to mark tx fulfilled:', error.message);

      email.sendTopupConfirmation(user, tx).catch(e => logger.error('Topup email:', e.message));
      break;
    }

    case 'charge.failed': {
      const { error } = await supabase.from('transactions').update({ status: 'failed' }).eq('id', pending.id);
      if (error) logger.error('DrexPay webhook: failed to mark tx failed:', error.message);
      break;
    }

    default:
      logger.debug(`Unhandled DrexPay event: ${event.event}`);
  }

  res.json({ received: true });
});
