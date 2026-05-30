/**
 * User routes — /api/users/*
 */
const router = require('express').Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const c = require('../controllers/userController');

router.use(protect);

router.get('/me',           c.getProfile);
router.patch('/me',         c.updateProfile);
router.delete('/me',        c.deleteAccount);

router.get('/dashboard-stats', c.getDashboardStats);

router.get('/api-keys',     c.listApiKeys);
router.post('/api-keys',
  [body('name').trim().isLength({ min: 1, max: 50 }).withMessage('Name required')],
  validate,
  c.createApiKey);
router.delete('/api-keys/:id', c.revokeApiKey);

router.get('/referral',     c.getReferralStats);

module.exports = router;
