/**
 * Product routes — public catalog + admin CRUD.
 * Mounted at /api/products (public) and /api/admin (admin CRUD).
 */
const express = require('express');
const c = require('../controllers/productController');
const { protect, requireRole } = require('../middleware/auth');

// ── PUBLIC ──
const publicRouter = express.Router();
publicRouter.get('/', c.listPublic);
publicRouter.get('/categories', c.listCategoriesPublic);

// Purchasing a Developer API plan requires an authenticated wallet —
// gated individually rather than router-wide since the two routes
// above are genuinely public (landing page catalog).
publicRouter.post('/:id/purchase-plan', protect, c.purchasePlan);

// ── ADMIN (session + role: admin) ──
const adminRouter = express.Router();
adminRouter.use(protect, requireRole('admin'));

adminRouter.get('/products',            c.adminList);
adminRouter.post('/products',           c.adminCreate);
adminRouter.patch('/products/:id',      c.adminUpdate);
adminRouter.patch('/products/:id/toggle', c.adminToggle);
adminRouter.delete('/products/:id',     c.adminDelete);
adminRouter.post('/products/sync-provider', c.syncFromProvider);

adminRouter.get('/categories',          c.adminListCategories);
adminRouter.post('/categories',         c.adminCreateCategory);
adminRouter.patch('/categories/:id',    c.adminUpdateCategory);
adminRouter.delete('/categories/:id',   c.adminDeleteCategory);

adminRouter.get('/providers',           c.adminListProviders);

module.exports = { publicRouter, adminRouter };
