/**
 * Wallet routes — /api/wallet/*
 */
const router = require('express').Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requireEmailVerified } = require('../middleware/auth');
const c = require('../controllers/walletController');

const topupRules = [
  body('amount').isFloat({ min: 1, max: 10000 }).withMessage('Amount must be $1 - $10,000'),
  body('method').isIn(['stripe','nowpayments','paypal']).withMessage('Invalid method'),
  body('payCurrency').optional().isString()
];

router.use(protect);

router.get('/',                            c.getWallet);
router.post('/topup', requireEmailVerified, topupRules, validate, c.initiateTopup);
router.get('/transactions',                c.getTransactions);
router.get('/transactions/:id',            c.getTransaction);

module.exports = router;
