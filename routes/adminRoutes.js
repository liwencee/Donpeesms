/**
 * Admin routes — cross-cutting views (users, orders).
 * Mounted at /api/admin, alongside routes/productRoutes.js's adminRouter.
 */
const express = require('express');
const c = require('../controllers/adminController');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(protect, requireRole('admin'));

router.get('/users',           c.listUsers);
router.patch('/users/:id/ban', c.toggleBan);
router.get('/orders',          c.listOrders);

module.exports = router;
