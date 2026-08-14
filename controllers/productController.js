/**
 * Product controller — admin-managed catalog (CRUD) + public listing.
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { generateKey } = require('../models/ApiKey');
const wallet        = require('./walletController');
const { syncProviderProducts } = require('../utils/syncProviderProducts');

// SureVerifications' raw "price" field has no documented unit or currency
// — the naive USD conversion used elsewhere in this codebase (see
// smsProvider.calculateUserPrice) produces an obviously-wrong number for
// it (₦3.49M for one WhatsApp number). Deliberately null until confirmed
// against a real amount from the account's own billing history — see
// utils/syncProviderProducts.js's header for the full reasoning.
const SURE_VERIFICATIONS_PRICE_TO_NAIRA = null;

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
  const hasCategory = req.query.category && req.query.category !== 'all';
  let query = supabase
    .from('products')
    .select(hasCategory ? '*, categories!inner(*)' : '*, categories(*)')
    .eq('enabled', true);
  if (hasCategory) {
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
  // Re-throw raw so errorHandler can classify constraint violations
  // (23505 → 409, 23503 → 400) instead of burying them in a 500.
  if (error) throw error;

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
  if (error) throw error; // see adminCreate — let errorHandler map constraint violations
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

// POST /api/admin/products/sync-provider
// Replaces the "One-Time OTP" catalog with SureVerifications' live
// service list (see utils/syncProviderProducts.js). Re-runnable any time
// the provider's catalog changes.
exports.syncFromProvider = asyncHandler(async (req, res) => {
  if (typeof SURE_VERIFICATIONS_PRICE_TO_NAIRA !== 'function') {
    throw new ApiError(500, 'Pricing conversion not yet confirmed for SureVerifications — see productController.js');
  }
  const result = await syncProviderProducts({ priceToNaira: SURE_VERIFICATIONS_PRICE_TO_NAIRA });
  res.json({ success: true, ...result });
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
  // categories.name and .slug are both unique — a clash is a 409, not a 500.
  if (error) throw error;
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
  if (error) throw error; // unique name/slug clash → 409 via errorHandler
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

// ═════════════════════════════════════════════
// POST /api/products/:id/purchase-plan
// Buys a Developer API catalog product: debits the wallet and issues a
// new API key carrying that plan's monthly quota (metadata.monthlyQuota
// on the product row; absent/null = unlimited, matching the Business
// tier). Scoped strictly to category 'api' — other catalog categories
// (One-Time OTP, Number Rentals) have no purchase-plan concept and are
// rejected rather than silently accepted.
// ═════════════════════════════════════════════
exports.purchasePlan = asyncHandler(async (req, res) => {
  const { data: product, error: prodErr } = await supabase
    .from('products').select('*, categories(*)').eq('id', req.params.id).maybeSingle();
  if (prodErr) throw new ApiError(500, prodErr.message);
  if (!product || !product.enabled) throw ApiError.notFound('Product not found');
  if (product.categories?.slug !== 'api') throw ApiError.badRequest('This product is not a Developer API plan');
  if (product.stock === 0) throw ApiError.badRequest('This plan is not currently available — contact sales');

  const { count: activeCount, error: countErr } = await supabase
    .from('api_keys').select('id', { count: 'exact', head: true })
    .eq('user_id', req.userId).eq('active', true);
  if (countErr) throw new ApiError(500, countErr.message);
  if (activeCount >= 5) throw ApiError.badRequest('Max 5 active API keys per account — revoke one first');

  // Debit BEFORE issuing the key: if the wallet doesn't have the funds,
  // nothing is created. debitWallet itself throws a clean 400 on
  // insufficient balance, which asyncHandler propagates as-is.
  await wallet.debitWallet({
    userId: req.userId,
    amount: product.price,
    description: `API plan: ${product.name}`
  });

  const monthlyQuota = product.metadata?.monthlyQuota ?? null;
  const { raw, hash, prefix } = generateKey();

  const { data: keyRow, error: keyErr } = await supabase.from('api_keys').insert({
    user_id: req.userId,
    name: `${product.name} Plan`,
    key_prefix: prefix,
    key_hash: hash,
    scopes: ['read', 'write'],
    monthly_quota: monthlyQuota,
    quota_used: 0,
    quota_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  }).select().single();
  if (keyErr) throw new ApiError(500, keyErr.message);

  res.status(201).json({
    success: true,
    message: 'Save this key — it will not be shown again',
    apiKey: {
      id: keyRow.id, name: keyRow.name, prefix, key: raw,
      monthlyQuota, quotaResetAt: keyRow.quota_reset_at
    }
  });
});
