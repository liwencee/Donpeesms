/**
 * Stripe webhook handler — confirms top-ups and credits wallet
 * Endpoint must receive RAW body, not JSON-parsed
 */
const stripe = require('../services/stripeService');
const Transaction = require('../models/Transaction');
const wallet = require('../controllers/walletController');
const email = require('../services/emailService');
const User = require('../models/User');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');

module.exports = asyncHandler(async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.verifyWebhook(req.body, signature);
  } catch (err) {
    logger.error('Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  logger.info(`Stripe webhook: ${event.type}`);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const meta = session.metadata || {};

      if (meta.purpose !== 'wallet_topup') break;

      const userId = meta.userId;
      const amount = parseFloat(meta.amount);
      const bonus = parseFloat(meta.bonus || '0');

      // Find pending tx
      const pending = await Transaction.findOne({ externalId: session.id, status: 'pending' });
      if (!pending) {
        logger.warn(`Stripe webhook: no pending tx for session ${session.id}`);
        break;
      }

      // Credit wallet
      const { user, tx } = await wallet.creditWallet({
        userId,
        amount,
        bonus,
        externalId: session.id,
        method: 'stripe',
        description: `Stripe top-up ($${amount})`
      });

      // Mark pending tx as fulfilled (or delete it; we keep audit)
      pending.status = 'success';
      pending.balanceAfter = user.walletBalance;
      pending.metadata = { ...pending.metadata, stripeSessionId: session.id, fulfilledTxId: tx._id };
      await pending.save();

      // Email
      email.sendTopupConfirmation(user, tx).catch(e => logger.error('Topup email:', e.message));
      break;
    }

    case 'payment_intent.payment_failed': {
      const intent = event.data.object;
      await Transaction.updateMany(
        { externalId: intent.id, status: 'pending' },
        { $set: { status: 'failed', externalStatus: intent.last_payment_error?.message } }
      );
      break;
    }

    case 'charge.refunded': {
      logger.info(`Stripe refund processed: ${event.data.object.id}`);
      break;
    }

    default:
      logger.debug(`Unhandled Stripe event: ${event.type}`);
  }

  res.json({ received: true });
});
