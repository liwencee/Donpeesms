/**
 * NowPayments IPN webhook handler — credits wallet on crypto confirmation
 */
const nowpay = require('../services/nowPaymentsService');
const Transaction = require('../models/Transaction');
const wallet = require('../controllers/walletController');
const email = require('../services/emailService');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');

module.exports = asyncHandler(async (req, res) => {
  const signature = req.headers['x-nowpayments-sig'];
  const rawBody = req.body;

  if (!nowpay.verifyIpnSignature(rawBody, signature)) {
    logger.warn('NowPayments IPN signature invalid');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  const { payment_id, payment_status, price_amount, actually_paid, order_id } = body;

  logger.info(`NowPayments IPN: ${payment_id} → ${payment_status}`);

  const pending = await Transaction.findOne({ externalId: String(payment_id), status: { $in: ['pending','processing'] } });
  if (!pending) {
    logger.warn(`No pending tx for payment_id ${payment_id}`);
    return res.json({ received: true });
  }

  switch (payment_status) {
    case 'waiting':
    case 'confirming':
      pending.status = 'processing';
      pending.externalStatus = payment_status;
      await pending.save();
      break;

    case 'finished':
    case 'confirmed':
    case 'sending':
    case 'partially_paid': {
      // For partial, credit only what was actually paid (capped at price)
      const creditAmount = Math.min(parseFloat(actually_paid || price_amount), parseFloat(price_amount));
      const { user, tx } = await wallet.creditWallet({
        userId: pending.user,
        amount: creditAmount,
        bonus: pending.bonusAmount || 0,
        externalId: String(payment_id),
        method: 'nowpayments',
        description: `Crypto top-up ${pending.cryptoCurrency} ($${creditAmount})`
      });

      pending.status = 'success';
      pending.balanceAfter = user.walletBalance;
      pending.cryptoTxHash = body.payin_hash;
      pending.externalStatus = payment_status;
      await pending.save();

      email.sendTopupConfirmation(user, tx).catch(e => logger.error('Topup email:', e.message));
      break;
    }

    case 'failed':
    case 'expired':
    case 'refunded':
      pending.status = 'failed';
      pending.externalStatus = payment_status;
      await pending.save();
      break;
  }

  res.json({ received: true });
});
