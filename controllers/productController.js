/**
 * Product controller — admin-managed catalog (CRUD) + public listing.
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

const slugify = (s) => String(s || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'item';

const shape = (p) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  price: p.price,
  imageUrl: p.image_url,
  color: p.color,
  stock: p.stock,
  stockLabel: p.stock_label,
  apiProvider: p.api_provider,
  enabled: p.enabled,
  featured: p.featured,
  sortOrder: p.sort_order,
  categoryId: p.category_id,
  category: p.categories ? { id: p.categories.id, name: p.categories.name, slug: p.categories.slug } : null,
  createdAt: p.created_at
});

const stockText = (p) => {
  if (p.stockLabel) return p.stockLabel;
  if (p.stock === 0) return 'Out of stock';
  return 'In stock';
};

// ═════════════════════════════════════════════
// PUBLIC
// ═════════════════════════════════════════════

// GET /api/products
exports.listPublic = asyncHandler(async (req, res) => {
  let query = supabase.from('products').select('*, categories(*)').eq('enabled', true);
  if (req.query.category && req.query.category !== 'all') {
    query = query.eq('categories.slug', req.query.category);
  }
  const { data, error } = await query.order('sort_order', { ascending: true }).order('created_at', { ascending: false });
  if (error) throw new ApiError(500, error.message);

  const shaped = data.map(shape);
  res.json({ success: true, count: shaped.length, products: shaped.map(p => ({ ...p, stockText: stockText(p) })) });
});

// GET /api/products/categories
exports.listCategoriesPublic = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('categories').select('*').eq('active', true)
    .order('sort_order', { ascending: true }).order('name', { ascending: true });
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, categories: data.map(c => ({ id: c.id, name: c.name, slug: c.slug, icon: c.icon })) });
});

// ═════════════════════════════════════════════
// ADMIN — PRODUCTS
// ═════════════════════════════════════════════

exports.adminList = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('products').select('*, categories(*)')
    .order('sort_order', { ascending: true }).order('created_at', { ascending: false });
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, count: data.length, products: data.map(shape) });
});

exports.adminCreate = asyncHandler(async (req, res) => {
  const { name, description, price, imageUrl, color, stock, stockLabel, apiProvider, categoryId, enabled, featured, sortOrder } = req.body;
  if (!name || !String(name).trim()) throw ApiError.badRequest('Product name is required');
  if (price == null || isNaN(parseFloat(price))) throw ApiError.badRequest('Valid price is required');

  const { data, error } = await supabase.from('products').insert({
    name: String(name).trim(),
    description: description || null,
    price: parseFloat(price),
    image_url: imageUrl || null,
    color: color || null,
    stock: stock == null ? -1 : parseInt(stock, 10),
    stock_label: stockLabel || null,
    api_provider: apiProvider || 'manual',
    category_id: categoryId || null,
    enabled: enabled == null ? true : !!enabled,
    featured: !!featured,
    sort_order: sortOrder == null ? 0 : parseInt(sortOrder, 10)
  }).select('*, categories(*)').single();
  if (error) throw new ApiError(500, error.message);

  res.status(201).json({ success: true, product: shape(data) });
});

exports.adminUpdate = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('products').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Product not found');

  const b = req.body;
  const data = {};
  if (b.name != null)        data.name = String(b.name).trim();
  if (b.description != null) data.description = b.description || null;
  if (b.price != null)       data.price = parseFloat(b.price);
  if (b.imageUrl != null)    data.image_url = b.imageUrl || null;
  if (b.color != null)       data.color = b.color || null;
  if (b.stock != null)       data.stock = parseInt(b.stock, 10);
  if (b.stockLabel != null)  data.stock_label = b.stockLabel || null;
  if (b.apiProvider != null) data.api_provider = b.apiProvider || 'manual';
  if (b.categoryId !== undefined) data.category_id = b.categoryId || null;
  if (b.enabled != null)     data.enabled = !!b.enabled;
  if (b.featured != null)    data.featured = !!b.featured;
  if (b.sortOrder != null)   data.sort_order = parseInt(b.sortOrder, 10);

  const { data: product, error } = await supabase.from('products').update(data).eq('id', req.params.id).select('*, categories(*)').single();
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, product: shape(product) });
});

exports.adminToggle = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('products').select('enabled').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Product not found');

  const { data: product, error } = await supabase
    .from('products').update({ enabled: !existing.enabled }).eq('id', req.params.id).select('*, categories(*)').single();
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, product: shape(product) });
});

exports.adminDelete = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('products').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Product not found');

  const { error } = await supabase.from('products').delete().eq('id', req.params.id);
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, message: 'Product deleted' });
});

// ═════════════════════════════════════════════
// ADMIN — CATEGORIES
// ═════════════════════════════════════════════

exports.adminListCategories = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('categories').select('*, products(count)')
    .order('sort_order', { ascending: true }).order('name', { ascending: true });
  if (error) throw new ApiError(500, error.message);

  res.json({
    success: true,
    categories: data.map(c => ({
      id: c.id, name: c.name, slug: c.slug, icon: c.icon, sortOrder: c.sort_order,
      active: c.active, productCount: c.products?.[0]?.count || 0
    }))
  });
});

exports.adminCreateCategory = asyncHandler(async (req, res) => {
  const { name, icon, sortOrder } = req.body;
  if (!name || !String(name).trim()) throw ApiError.badRequest('Category name is required');

  const base = slugify(name);
  let slug = base, n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: taken } = await supabase.from('categories').select('id').eq('slug', slug).maybeSingle();
    if (!taken) break;
    slug = `${base}-${n++}`;
  }

  const { data, error } = await supabase.from('categories').insert({
    name: String(name).trim(), slug, icon: icon || null, sort_order: sortOrder == null ? 0 : parseInt(sortOrder, 10)
  }).select().single();
  if (error) throw new ApiError(500, error.message);
  res.status(201).json({ success: true, category: data });
});

exports.adminUpdateCategory = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('categories').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Category not found');

  const b = req.body;
  const data = {};
  if (b.name != null)      data.name = String(b.name).trim();
  if (b.icon != null)      data.icon = b.icon || null;
  if (b.sortOrder != null) data.sort_order = parseInt(b.sortOrder, 10);
  if (b.active != null)    data.active = !!b.active;

  const { data: cat, error } = await supabase.from('categories').update(data).eq('id', req.params.id).select().single();
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, category: cat });
});

exports.adminDeleteCategory = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('categories').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Category not found');

  const { error } = await supabase.from('categories').delete().eq('id', req.params.id);
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, message: 'Category deleted' });
});

// GET /api/admin/providers
exports.adminListProviders = asyncHandler(async (_req, res) => {
  const env = require('../config/env');
  const builtIn = [
    { id: 'manual', name: 'Manual fulfilment', configured: true },
    { id: 'sureverifications', name: 'SureVerifications', configured: !!(env.sms.sureVerifications && env.sms.sureVerifications.apiKey) }
  ];
  const { data, error } = await supabase.from('api_providers').select('*').eq('enabled', true).order('name', { ascending: true });
  if (error) throw new ApiError(500, error.message);

  res.json({
    success: true,
    providers: [...builtIn, ...data.map(p => ({ id: p.slug, name: p.name, configured: !!p.api_key_enc }))]
  });
});
