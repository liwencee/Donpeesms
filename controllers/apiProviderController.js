/**
 * API Provider controller — admin CRUD for 3rd-party integrations
 * (name, base URL, auth header, API key). Keys are stored encrypted
 * (utils/crypto.js) and never returned in full — only a masked preview.
 */
const { prisma }   = require('../config/db');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { encrypt, maskSecret } = require('../utils/crypto');

const slugify = (s) => String(s || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'provider';

const shape = (p) => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  baseUrl: p.baseUrl,
  authHeader: p.authHeader,
  hasKey: !!p.apiKeyEnc,
  keyPreview: p._rawKey ? maskSecret(p._rawKey) : (p.apiKeyEnc ? '••••••••' : null),
  notes: p.notes,
  enabled: p.enabled,
  createdAt: p.createdAt
});

// GET /api/admin/api-providers
exports.list = asyncHandler(async (_req, res) => {
  const providers = await prisma.apiProvider.findMany({ orderBy: { name: 'asc' } });
  res.json({ success: true, count: providers.length, providers: providers.map(shape) });
});

// POST /api/admin/api-providers
exports.create = asyncHandler(async (req, res) => {
  const { name, baseUrl, authHeader, apiKey, notes, enabled } = req.body;
  if (!name || !String(name).trim()) throw ApiError.badRequest('Provider name is required');
  if (!baseUrl || !String(baseUrl).trim()) throw ApiError.badRequest('Base URL is required');

  const base = slugify(name);
  let slug = base, n = 1;
  while (await prisma.apiProvider.findUnique({ where: { slug } })) { slug = `${base}-${n++}`; }

  const provider = await prisma.apiProvider.create({
    data: {
      name: String(name).trim(),
      slug,
      baseUrl: String(baseUrl).trim(),
      authHeader: (authHeader || 'x-api-key').trim(),
      apiKeyEnc: apiKey ? encrypt(apiKey) : null,
      notes: notes || null,
      enabled: enabled == null ? true : !!enabled
    }
  });
  res.status(201).json({ success: true, provider: shape({ ...provider, _rawKey: apiKey }) });
});

// PATCH /api/admin/api-providers/:id
exports.update = asyncHandler(async (req, res) => {
  const existing = await prisma.apiProvider.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Provider not found');

  const b = req.body;
  const data = {};
  if (b.name != null)       data.name = String(b.name).trim();
  if (b.baseUrl != null)    data.baseUrl = String(b.baseUrl).trim();
  if (b.authHeader != null) data.authHeader = String(b.authHeader).trim() || 'x-api-key';
  if (b.notes != null)      data.notes = b.notes || null;
  if (b.enabled != null)    data.enabled = !!b.enabled;
  // Only re-encrypt if a new key was actually provided (blank = keep existing).
  if (b.apiKey) data.apiKeyEnc = encrypt(b.apiKey);

  const provider = await prisma.apiProvider.update({ where: { id: req.params.id }, data });
  res.json({ success: true, provider: shape({ ...provider, _rawKey: b.apiKey || null }) });
});

// PATCH /api/admin/api-providers/:id/toggle
exports.toggle = asyncHandler(async (req, res) => {
  const existing = await prisma.apiProvider.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Provider not found');
  const provider = await prisma.apiProvider.update({
    where: { id: req.params.id },
    data: { enabled: !existing.enabled }
  });
  res.json({ success: true, provider: shape(provider) });
});

// DELETE /api/admin/api-providers/:id
exports.remove = asyncHandler(async (req, res) => {
  const existing = await prisma.apiProvider.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Provider not found');
  await prisma.apiProvider.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Provider deleted' });
});

// Internal helper — get a decrypted key for a slug (used by fulfilment
// code, never exposed over HTTP). Not wired into the SMS provider
// abstraction yet; available for future custom-provider fulfilment.
exports._getDecryptedKey = async (slug) => {
  const { decrypt } = require('../utils/crypto');
  const p = await prisma.apiProvider.findUnique({ where: { slug } });
  return p && p.apiKeyEnc ? decrypt(p.apiKeyEnc) : null;
};
