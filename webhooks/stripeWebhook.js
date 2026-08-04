/**
 * Stripe webhook handler — confirms top-ups and credits wallet
 * Endpoint must receive RAW body, not JSON-parsed
 */
const stripe       = require('../services/stripeService');
const { supabase } = require('../config/supabase');
const wallet       = require('../controllers/walletController');
const email        = require('../services/emailService');
const logger       = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const { toCamelCase } = require('../utils/caseMapper');

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
      const meta    = session.metadata || {};

      if (meta.purpose !== 'wallet_topup') break;

      const userId = meta.userId;
      const amount = parseFloat(meta.amount);
      const bonus  = parseFloat(meta.bonus || '0');

      const { data: pendingRow, error: findErr } = await supabase
        .from('transactions').select('*').eq('external_id', session.id).eq('status', 'pending').maybeSingle();
      if (findErr) { logger.error('Stripe webhook lookup failed:', findErr.message); break; }
      if (!pendingRow) {
        logger.warn(`Stripe webhook: no pending tx for session ${session.id}`);
        break;
      }
      const pending = toCamelCase(pendingRow);

      const { user, tx } = await wallet.creditWallet({
        userId, amount, bonus, externalId: session.id, method: 'stripe',
        description: `Stripe top-up ($${amount})`
      });

      const { error: updateErr } = await supabase.from('transactions').update({
        status: 'success',
        balance_after: user.walletBalance,
        metadata: { ...(pending.metadata || {}), stripeSessionId: session.id, fulfilledTxId: tx.id }
      }).eq('id', pending.id);
      if (updateErr) logger.error('Stripe webhook: failed to mark pending tx fulfilled:', updateErr.message);

      email.sendTopupConfirmation(user, tx).catch(e => logger.error('Topup email:', e.message));
      break;
    }

    case 'payment_intent.payment_failed': {
      const intent = event.data.object;
      const { error } = await supabase.from('transactions').update({
        status: 'failed', external_status: intent.last_payment_error?.message || null
      }).eq('external_id', intent.id).eq('status', 'pending');
      if (error) logger.error('Stripe webhook: failed to mark tx failed:', error.message);
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
