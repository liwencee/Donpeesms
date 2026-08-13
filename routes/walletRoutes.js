/**
 * Wallet routes — /api/wallet/*
 */
const router = require('express').Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const c = require('../controllers/walletController');

const topupRules = [
  body('amount').isFloat({ min: 300, max: 15000000 }).withMessage('Amount must be ₦300 - ₦15,000,000'),
  body('method').isIn(['drexpay']).withMessage('Invalid method'),
  body('payCurrency').optional().isString()
];

router.use(protect);

router.get('/',                            c.getWallet);
router.post('/topup', topupRules, validate, c.initiateTopup);
router.get('/transactions',                c.getTransactions);
router.get('/transactions/:id',            c.getTransaction);

module.exports = router;
