/**
 * Telegram service — posts ops notifications to a channel via the Bot
 * API. Fire-and-forget by design: a purchase must succeed or fail on its
 * own merits regardless of whether this notification sends.
 */
const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');

let warned = false;

exports.notifyPurchase = async (order) => {
  const { botToken, chatId } = env.telegram;
  if (!botToken || !chatId) {
    if (!warned) { logger.warn('Telegram not configured — purchase notifications disabled'); warned = true; }
    return;
  }
  const text = `🛒 New order\n${order.serviceType.toUpperCase()} · ${order.service} · ${order.country}\n${order.phoneNumber}\n₦${order.userCost}`;
  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text });
  } catch (err) {
    logger.warn('Telegram notify failed:', err.message);
  }
};
