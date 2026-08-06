/**
 * telegramService — must never let a missing config or a failed Telegram
 * API call affect the purchase flow that calls it. These tests exist to
 * pin that contract, not just "does it send a message."
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('axios');

const axios = require('axios');
const logger = require('../utils/logger');
const env = require('../config/env');
const telegram = require('../services/telegramService');

const sampleOrder = {
  serviceType: 'sms', service: 'telegram', country: 'NG',
  phoneNumber: '+2348012345678', userCost: 80
};

describe('telegramService.notifyPurchase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    env.telegram = {};
  });

  test('unconfigured: does not call axios, does not throw', async () => {
    await expect(telegram.notifyPurchase(sampleOrder)).resolves.toBeUndefined();
    expect(axios.post).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Telegram not configured — purchase notifications disabled');
  });

  test('configured: posts to the Bot API with the token in the URL and the right body', async () => {
    env.telegram = { botToken: 'abc123', chatId: '@donpee_logs' };
    axios.post.mockResolvedValue({ data: { ok: true } });
    await telegram.notifyPurchase(sampleOrder);
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.telegram.org/botabc123/sendMessage',
      expect.objectContaining({
        chat_id: '@donpee_logs',
        text: expect.stringContaining('+2348012345678')
      })
    );
  });

  test('configured but Telegram API rejects: still resolves, logs a warning, does not throw', async () => {
    env.telegram = { botToken: 'abc123', chatId: '@donpee_logs' };
    axios.post.mockRejectedValue(new Error('Bad Request: chat not found'));
    await expect(telegram.notifyPurchase(sampleOrder)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('Telegram notify failed:', 'Bad Request: chat not found');
  });
});
