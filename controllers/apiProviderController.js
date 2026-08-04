/**
 * API Provider controller — admin CRUD for 3rd-party integrations.
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { encrypt, maskSecret } = require('../utils/crypto');

const slugify = (s) => String(s || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'provider';

const shape = (p, rawKey) => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  baseUrl: p.base_url,
  authHeader: p.auth_header,
  hasKey: !!p.api_key_enc,
  keyPreview: rawKey ? maskSecret(rawKey) : (p.api_key_enc ? '••••••••' : null),
  notes: p.notes,
  enabled: p.enabled,
  createdAt: p.created_at
});

exports.list = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase.from('api_providers').select('*').order('name', { ascending: true });
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, count: data.length, providers: data.map(p => shape(p)) });
});

exports.create = asyncHandler(async (req, res) => {
  const { name, baseUrl, authHeader, apiKey, notes, enabled } = req.body;
  if (!name || !String(name).trim()) throw ApiError.badRequest('Provider name is required');
  if (!baseUrl || !String(baseUrl).trim()) throw ApiError.badRequest('Base URL is required');

  const base = slugify(name);
  let slug = base, n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: taken } = await supabase.from('api_providers').select('id').eq('slug', slug).maybeSingle();
    if (!taken) break;
    slug = `${base}-${n++}`;
  }

  const { data, error } = await supabase.from('api_providers').insert({
    name: String(name).trim(), slug, base_url: String(baseUrl).trim(),
    auth_header: (authHeader || 'x-api-key').trim(), api_key_enc: apiKey ? encrypt(apiKey) : null,
    notes: notes || null, enabled: enabled == null ? true : !!enabled
  }).select().single();
  // api_providers.name and .slug are both unique — re-throw raw so
  // errorHandler maps 23505 to a 409 instead of a generic 500.
  if (error) throw error;

  res.status(201).json({ success: true, provider: shape(data, apiKey) });
});

exports.update = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('api_providers').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Provider not found');

  const b = req.body;
  const data = {};
  if (b.name != null)       data.name = String(b.name).trim();
  if (b.baseUrl != null)    data.base_url = String(b.baseUrl).trim();
  if (b.authHeader != null) data.auth_header = String(b.authHeader).trim() || 'x-api-key';
  if (b.notes != null)      data.notes = b.notes || null;
  if (b.enabled != null)    data.enabled = !!b.enabled;
  if (b.apiKey) data.api_key_enc = encrypt(b.apiKey);

  const { data: provider, error } = await supabase.from('api_providers').update(data).eq('id', req.params.id).select().single();
  if (error) throw error; // see create — unique name/slug clash → 409
  res.json({ success: true, provider: shape(provider, b.apiKey || null) });
});

exports.toggle = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('api_providers').select('enabled').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Provider not found');

  const { data: provider, error } = await supabase
    .from('api_providers').update({ enabled: !existing.enabled }).eq('id', req.params.id).select().single();
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, provider: shape(provider) });
});

exports.remove = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('api_providers').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Provider not found');

  const { error } = await supabase.from('api_providers').delete().eq('id', req.params.id);
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, message: 'Provider deleted' });
});

exports._getDecryptedKey = async (slug) => {
  const { decrypt } = require('../utils/crypto');
  const { data, error } = await supabase.from('api_providers').select('api_key_enc').eq('slug', slug).maybeSingle();
  if (error) throw new ApiError(500, error.message);
  return data && data.api_key_enc ? decrypt(data.api_key_enc) : null;
};
