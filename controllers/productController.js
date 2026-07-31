/**
 * Product controller — admin-managed catalog (CRUD) + public listing.
 */
const { prisma }   = require('../config/db');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

const slugify = (s) => String(s || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'item';

// ── shape a product for API responses ──
const shape = (p) => ({
  id:          p.id,
  name:        p.name,
  description: p.description,
  price:       p.price,
  imageUrl:    p.imageUrl,
  color:       p.color,
  stock:       p.stock,
  stockLabel:  p.stockLabel,
  apiProvider: p.apiProvider,
  enabled:     p.enabled,
  featured:    p.featured,
  sortOrder:   p.sortOrder,
  categoryId:  p.categoryId,
  category:    p.category ? { id: p.category.id, name: p.category.name, slug: p.category.slug } : null,
  createdAt:   p.createdAt
});

// A product's public stock label ("In stock" / "Out of stock" / manual).
const stockText = (p) => {
  if (p.stockLabel) return p.stockLabel;
  if (p.stock === 0) return 'Out of stock';
  return 'In stock';
};

// ═════════════════════════════════════════════
// PUBLIC
// ═════════════════════════════════════════════

// GET /api/products  — enabled products, optional ?category=slug
exports.listPublic = asyncHandler(async (req, res) => {
  const where = { enabled: true };
  if (req.query.category && req.query.category !== 'all') {
    where.category = { slug: req.query.category };
  }
  const products = await prisma.product.findMany({
    where,
    include: { category: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }]
  });
  res.json({
    success: true,
    count: products.length,
    products: products.map(p => ({ ...shape(p), stockText: stockText(p) }))
  });
});

// GET /api/products/categories — active categories
exports.listCategoriesPublic = asyncHandler(async (_req, res) => {
  const cats = await prisma.category.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
  });
  res.json({ success: true, categories: cats.map(c => ({ id: c.id, name: c.name, slug: c.slug, icon: c.icon })) });
});

// ═════════════════════════════════════════════
// ADMIN — PRODUCTS
// ═════════════════════════════════════════════

// GET /api/admin/products — every product
exports.adminList = asyncHandler(async (_req, res) => {
  const products = await prisma.product.findMany({
    include: { category: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }]
  });
  res.json({ success: true, count: products.length, products: products.map(shape) });
});

// POST /api/admin/products
exports.adminCreate = asyncHandler(async (req, res) => {
  const { name, description, price, imageUrl, color, stock, stockLabel, apiProvider, categoryId, enabled, featured, sortOrder } = req.body;
  if (!name || !String(name).trim()) throw ApiError.badRequest('Product name is required');
  if (price == null || isNaN(parseFloat(price))) throw ApiError.badRequest('Valid price is required');

  const product = await prisma.product.create({
    data: {
      name: String(name).trim(),
      description: description || null,
      price: parseFloat(price),
      imageUrl: imageUrl || null,
      color: color || null,
      stock: stock == null ? -1 : parseInt(stock, 10),
      stockLabel: stockLabel || null,
      apiProvider: apiProvider || 'manual',
      categoryId: categoryId || null,
      enabled: enabled == null ? true : !!enabled,
      featured: !!featured,
      sortOrder: sortOrder == null ? 0 : parseInt(sortOrder, 10)
    },
    include: { category: true }
  });
  res.status(201).json({ success: true, product: shape(product) });
});

// PATCH /api/admin/products/:id
exports.adminUpdate = asyncHandler(async (req, res) => {
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Product not found');

  const b = req.body;
  const data = {};
  if (b.name != null)        data.name = String(b.name).trim();
  if (b.description != null)  data.description = b.description || null;
  if (b.price != null)        data.price = parseFloat(b.price);
  if (b.imageUrl != null)     data.imageUrl = b.imageUrl || null;
  if (b.color != null)        data.color = b.color || null;
  if (b.stock != null)        data.stock = parseInt(b.stock, 10);
  if (b.stockLabel != null)   data.stockLabel = b.stockLabel || null;
  if (b.apiProvider != null)  data.apiProvider = b.apiProvider || 'manual';
  if (b.categoryId !== undefined) data.categoryId = b.categoryId || null;
  if (b.enabled != null)      data.enabled = !!b.enabled;
  if (b.featured != null)     data.featured = !!b.featured;
  if (b.sortOrder != null)    data.sortOrder = parseInt(b.sortOrder, 10);

  const product = await prisma.product.update({ where: { id: req.params.id }, data, include: { category: true } });
  res.json({ success: true, product: shape(product) });
});

// PATCH /api/admin/products/:id/toggle — enable/disable
exports.adminToggle = asyncHandler(async (req, res) => {
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Product not found');
  const product = await prisma.product.update({
    where: { id: req.params.id },
    data: { enabled: !existing.enabled },
    include: { category: true }
  });
  res.json({ success: true, product: shape(product) });
});

// DELETE /api/admin/products/:id
exports.adminDelete = asyncHandler(async (req, res) => {
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Product not found');
  await prisma.product.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Product deleted' });
});

// ═════════════════════════════════════════════
// ADMIN — CATEGORIES
// ═════════════════════════════════════════════

exports.adminListCategories = asyncHandler(async (_req, res) => {
  const cats = await prisma.category.findMany({
    include: { _count: { select: { products: true } } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
  });
  res.json({
    success: true,
    categories: cats.map(c => ({ id: c.id, name: c.name, slug: c.slug, icon: c.icon, sortOrder: c.sortOrder, active: c.active, productCount: c._count.products }))
  });
});

exports.adminCreateCategory = asyncHandler(async (req, res) => {
  const { name, icon, sortOrder } = req.body;
  if (!name || !String(name).trim()) throw ApiError.badRequest('Category name is required');
  const base = slugify(name);
  // ensure unique slug
  let slug = base, n = 1;
  while (await prisma.category.findUnique({ where: { slug } })) { slug = `${base}-${n++}`; }
  const cat = await prisma.category.create({
    data: { name: String(name).trim(), slug, icon: icon || null, sortOrder: sortOrder == null ? 0 : parseInt(sortOrder, 10) }
  });
  res.status(201).json({ success: true, category: cat });
});

exports.adminUpdateCategory = asyncHandler(async (req, res) => {
  const existing = await prisma.category.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Category not found');
  const b = req.body;
  const data = {};
  if (b.name != null)      data.name = String(b.name).trim();
  if (b.icon != null)      data.icon = b.icon || null;
  if (b.sortOrder != null) data.sortOrder = parseInt(b.sortOrder, 10);
  if (b.active != null)    data.active = !!b.active;
  const cat = await prisma.category.update({ where: { id: req.params.id }, data });
  res.json({ success: true, category: cat });
});

exports.adminDeleteCategory = asyncHandler(async (req, res) => {
  const existing = await prisma.category.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Category not found');
  // Products keep existing; their categoryId is set null via onDelete: SetNull.
  await prisma.category.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Category deleted' });
});

// GET /api/admin/providers — available API providers for assignment
// (built-in code-level providers + admin-added custom ones, merged).
exports.adminListProviders = asyncHandler(async (_req, res) => {
  const env = require('../config/env');
  const builtIn = [
    { id: 'manual',            name: 'Manual fulfilment', configured: true },
    { id: 'sureverifications', name: 'SureVerifications', configured: !!(env.sms.sureVerifications && env.sms.sureVerifications.apiKey) }
  ];
  const custom = await prisma.apiProvider.findMany({ where: { enabled: true }, orderBy: { name: 'asc' } });
  res.json({
    success: true,
    providers: [
      ...builtIn,
      ...custom.map(p => ({ id: p.slug, name: p.name, configured: !!p.apiKeyEnc }))
    ]
  });
});
