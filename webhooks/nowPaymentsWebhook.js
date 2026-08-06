/**
 * NowPayments IPN webhook handler — credits wallet on crypto confirmation
 */
const nowpay       = require('../services/nowPaymentsService');
const { supabase } = require('../config/supabase');
const wallet       = require('../controllers/walletController');
const email        = require('../services/emailService');
const logger       = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { toCamelCase } = require('../utils/caseMapper');

module.exports = asyncHandler(async (req, res) => {
  const signature = req.headers['x-nowpayments-sig'];
  const rawBody   = req.body;

  if (!nowpay.verifyIpnSignature(rawBody, signature)) {
    logger.warn('NowPayments IPN signature invalid');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  const { payment_id, payment_status, price_amount, actually_paid } = body;

  logger.info(`NowPayments IPN: ${payment_id} → ${payment_status}`);

  const { data: pendingRow, error: findErr } = await supabase
    .from('transactions').select('*').eq('external_id', String(payment_id)).in('status', ['pending', 'processing']).maybeSingle();
  if (findErr) { logger.error('NowPayments webhook lookup failed:', findErr.message); return res.json({ received: true }); }
  if (!pendingRow) {
    logger.warn(`No pending tx for payment_id ${payment_id}`);
    return res.json({ received: true });
  }
  const pending = toCamelCase(pendingRow);

  switch (payment_status) {
    case 'waiting':
    case 'confirming': {
      const { error } = await supabase.from('transactions').update({
        status: 'processing', external_status: payment_status
      }).eq('id', pending.id);
      if (error) logger.error('NowPayments webhook: failed to mark processing:', error.message);
      break;
    }

    case 'finished':
    case 'confirmed':
    case 'sending':
    case 'partially_paid': {
      // For partial, credit only what was actually paid (capped at price)
      const creditAmount = Math.min(
        parseFloat(actually_paid || price_amount),
        parseFloat(price_amount)
      );
      const { user, tx } = await wallet.creditWallet({
        userId:      pending.userId,
        amount:      creditAmount,
        bonus:       pending.bonusAmount || 0,
        externalId:  String(payment_id),
        method:      'nowpayments',
        description: `Crypto top-up ${pending.cryptoCurrency} ($${creditAmount})`
      });

      const { error } = await supabase.from('transactions').update({
        status:          'success',
        balance_after:   user.walletBalance,
        crypto_tx_hash:  body.payin_hash,
        external_status: payment_status
      }).eq('id', pending.id);
      if (error) logger.error('NowPayments webhook: failed to mark success:', error.message);

      email.sendTopupConfirmation(user, tx)
        .catch(e => logger.error('Topup email:', e.message));
      break;
    }

    case 'failed':
    case 'expired':
    case 'refunded': {
      const { error } = await supabase.from('transactions').update({
        status: 'failed', external_status: payment_status
      }).eq('id', pending.id);
      if (error) logger.error('NowPayments webhook: failed to mark failed:', error.message);
      break;
    }
  }

  res.json({ received: true });
});
