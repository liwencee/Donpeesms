/**
 * Number routes — /api/numbers/*
 */
const router = require('express').Router();
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requireEmailVerified, apiKeyAuth } = require('../middleware/auth');
const { purchaseLimiter } = require('../middleware/rateLimiter');
const c = require('../controllers/numberController');

const buyRules = [
  body('serviceType').isIn(['whatsapp','sms']).withMessage('serviceType: whatsapp | sms'),
  body('country').isLength({ min: 2, max: 4 }).withMessage('Country code required'),
  body('service').optional().isString().isLength({ max: 30 })
];

const priceRules = [
  query('country').isLength({ min: 2, max: 4 }),
  query('service').optional().isString()
];

// ── PUBLIC ──
router.get('/countries',  c.listCountries);
router.get('/services',   c.listServices);
router.get('/price',      priceRules, validate, c.getPrice);

// ── AUTH (session) ──
router.use(protect);

router.post('/buy',                  purchaseLimiter, requireEmailVerified, buyRules, validate, c.buyNumber);
router.get('/orders',                c.listOrders);
router.get('/orders/:id',            c.getOrder);
router.get('/orders/:id/status',     c.checkOrderStatus);
router.post('/orders/:id/cancel',    c.cancelOrder);

module.exports = router;

// ── API KEY routes (separate router for /api/v1/*) ──
const apiRouter = require('express').Router();
apiRouter.use(apiKeyAuth);
apiRouter.get('/price',              priceRules, validate, c.getPrice);
apiRouter.post('/numbers',           purchaseLimiter, buyRules, validate, c.buyNumber);
apiRouter.get('/numbers/:id',        c.getOrder);
apiRouter.get('/numbers/:id/status', c.checkOrderStatus);
apiRouter.post('/numbers/:id/cancel',c.cancelOrder);
apiRouter.get('/numbers',            c.listOrders);

module.exports.apiRouter = apiRouter;
