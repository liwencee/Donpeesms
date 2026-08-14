/**
 * Syncs the "One-Time OTP" product catalog from SureVerifications' live
 * service list, replacing the old hand-picked set. Re-runnable — safe to
 * call again any time the provider's catalog changes.
 *
 * server1 is the source (the app's primary tier everywhere else; server2
 * is the fallback with a much larger, less-curated long-tail list).
 * Duplicate service names (SureVerifications lists plain "Whatsapp" four
 * times under different opaque ids, for example) are collapsed to the
 * cheapest in-stock variant.
 *
 * priceToNaira has NO default on purpose — the raw price unit returned by
 * the API isn't documented anywhere and the naive USD conversion already
 * used elsewhere in this codebase produces an obviously-wrong number
 * (₦3.49M for a single WhatsApp number). Callers must supply a real,
 * confirmed conversion rather than silently inheriting a guess.
 */
require('dotenv').config();
const { supabase } = require('../config/supabase');
const { getProvider } = require('../services/smsProvider');

const findCountryId = async (provider, iso2 = 'NG') => {
  const countries = await provider.getCountries();
  const country = countries.find(c => c.data?.iso2 === iso2);
  if (!country) throw new Error(`Country ${iso2} not found in provider country list`);
  return country.id;
};

// Groups services by exact name, fetches price for every variant, keeps
// the cheapest in-stock one per name (falls back to cheapest overall if
// nothing is in stock).
const buildCatalog = async (provider, countryId, server = 'server1') => {
  const services = await provider.getServicesForCountry(countryId, server);
  const byName = {};
  for (const s of services) (byName[s.name] ||= []).push(s);

  const catalog = [];
  for (const [name, variants] of Object.entries(byName)) {
    let best = null;
    for (const v of variants) {
      const price = await provider.getServicePrice(countryId, v.id, server);
      if (price.cost == null) continue;
      const better = !best
        || (price.inStock && !best.inStock)
        || (price.inStock === best.inStock && price.cost < best.cost);
      if (better) best = { ...price, id: v.id, name };
    }
    if (best) catalog.push(best);
  }
  return catalog.sort((a, b) => a.name.localeCompare(b.name));
};

// Read-only — fetches and prices the live catalog, no DB writes. Safe to
// call any time to preview what a real sync would produce.
const previewProviderProducts = async (iso2 = 'NG') => {
  const provider = getProvider('sureverifications');
  const countryId = await findCountryId(provider, iso2);
  const catalog = await buildCatalog(provider, countryId, 'server1');
  return { countryId, catalog };
};

const syncProviderProducts = async ({ priceToNaira, iso2 = 'NG' }) => {
  if (typeof priceToNaira !== 'function') throw new Error('syncProviderProducts requires a confirmed priceToNaira(rawCost) function');

  const provider = getProvider('sureverifications');
  const countryId = await findCountryId(provider, iso2);
  const catalog = await buildCatalog(provider, countryId, 'server1');

  const { data: cat, error: catErr } = await supabase.from('categories').select('id').eq('slug', 'otp').single();
  if (catErr) throw catErr;

  // Soft-disable every OTP-category row this sync didn't itself tag,
  // rather than deleting them — reversible, and nothing else references
  // products by id (orders are driven by country/service directly, not
  // product_id). NOT api_provider = 'manual': the old hand-picked rows
  // were seeded with api_provider: 'sureverifications' too (seedProducts.js
  // sets it on every category), so that filter matched nothing on the
  // first real run and left 8 stale rows enabled alongside their live
  // replacements. metadata.sureVerifications.serviceId is the one marker
  // that's actually unique to rows this sync has written.
  const { data: existingOtp, error: existingErr } = await supabase
    .from('products').select('id, metadata').eq('category_id', cat.id).eq('enabled', true);
  if (existingErr) throw existingErr;

  const staleIds = existingOtp.filter(p => !p.metadata?.sureVerifications?.serviceId).map(p => p.id);
  if (staleIds.length) {
    const { error: disableErr } = await supabase.from('products').update({ enabled: false }).in('id', staleIds);
    if (disableErr) throw disableErr;
  }

  let created = 0, updated = 0;
  for (const [i, item] of catalog.entries()) {
    const row = {
      name: `${item.name} Number`,
      description: `Receive a one-time ${item.name} verification code instantly.`,
      price: priceToNaira(item.cost),
      category_id: cat.id,
      api_provider: 'sureverifications',
      stock: item.inStock ? -1 : 0,
      stock_label: item.inStock ? null : 'Out of stock',
      enabled: true,
      sort_order: i,
      metadata: { sureVerifications: { serviceId: item.id, countryId, server: item.server, rawCost: item.cost } }
    };

    const { data: existing, error: findErr } = await supabase
      .from('products').select('id')
      .eq('api_provider', 'sureverifications')
      .eq('metadata->sureVerifications->>serviceId', item.id)
      .maybeSingle();
    if (findErr) throw findErr;

    if (existing) {
      const { error } = await supabase.from('products').update(row).eq('id', existing.id);
      if (error) throw error;
      updated++;
    } else {
      const { error } = await supabase.from('products').insert(row);
      if (error) throw error;
      created++;
    }
  }
  return { created, updated, total: catalog.length };
};

module.exports = { previewProviderProducts, syncProviderProducts, findCountryId, buildCatalog };

if (require.main === module) {
  previewProviderProducts().then(({ countryId, catalog }) => {
    console.log(`Nigeria country_id=${countryId}, ${catalog.length} services priced:\n`);
    console.log(JSON.stringify(catalog, null, 2));
    process.exit(0);
  }).catch(err => { console.error('Preview failed:', err.message); process.exit(1); });
}
