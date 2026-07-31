/**
 * API Provider routes — admin CRUD. Mounted at /api/admin/api-providers.
 */
const express = require('express');
const c = require('../controllers/apiProviderController');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(protect, requireRole('admin'));

router.get('/',            c.list);
router.post('/',           c.create);
router.patch('/:id',       c.update);
router.patch('/:id/toggle', c.toggle);
router.delete('/:id',      c.remove);

module.exports = router;
