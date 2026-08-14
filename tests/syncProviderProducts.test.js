/**
 * utils/syncProviderProducts.js — the part worth locking in with a test
 * is the dedup logic: SureVerifications lists the same service name
 * multiple times under different opaque ids (confirmed live: "Whatsapp"
 * four times, "Telegram" three times, on server1 alone), and picking the
 * wrong variant means either overpaying or listing something out of
 * stock as available.
 */
jest.mock('../config/supabase', () => ({ supabase: { from: jest.fn() } }));
// Keep the real dedupeServicesByName (buildCatalog delegates to it) —
// only getProvider needs mocking here.
jest.mock('../services/smsProvider', () => ({
  ...jest.requireActual('../services/smsProvider'),
  getProvider: jest.fn()
}));

const { supabase } = require('../config/supabase');
const { getProvider } = require('../services/smsProvider');
const { buildCatalog, findCountryId, syncProviderProducts } = require('../utils/syncProviderProducts');

// Queues one chainable+thenable "table" result per supabase.from() call, in
// call order. select/update/insert/eq/in/maybeSingle/single all just
// return the same object (recording their args) so any chain shape
// resolves to the queued value — returns the recorded call log.
const queueSupabaseResults = (results) => {
  const log = [];
  let i = 0;
  supabase.from.mockImplementation((table) => {
    const result = results[i++];
    const record = (method) => (...args) => { log.push({ table, method, args }); return builder; };
    const builder = {
      select: record('select'), update: record('update'), insert: record('insert'),
      eq: record('eq'), in: record('in'),
      maybeSingle: () => Promise.resolve(result), single: () => Promise.resolve(result),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
    };
    return builder;
  });
  return log;
};

const fakeProvider = (services, prices) => ({
  getCountries: jest.fn().mockResolvedValue([
    { id: 159, name: 'Nigeria', data: { iso2: 'NG' } },
    { id: 236, name: 'United States', data: { iso2: 'US' } }
  ]),
  getServicesForCountry: jest.fn().mockResolvedValue(services),
  getServicePrice: jest.fn((countryId, serviceId) => Promise.resolve(prices[serviceId]))
});

describe('findCountryId', () => {
  test('resolves the numeric id for a known iso2 code', async () => {
    const provider = fakeProvider([], {});
    await expect(findCountryId(provider, 'NG')).resolves.toBe(159);
  });

  test('throws for an unknown iso2 code rather than returning undefined', async () => {
    const provider = fakeProvider([], {});
    await expect(findCountryId(provider, 'ZZ')).rejects.toThrow('ZZ');
  });
});

describe('buildCatalog', () => {
  test('keeps a single-variant service as-is', async () => {
    const provider = fakeProvider(
      [{ id: 's1', name: 'Telegram' }],
      { s1: { cost: 2600, inStock: true, server: 'server1' } }
    );
    const catalog = await buildCatalog(provider, 159, 'server1');
    expect(catalog).toEqual([{ cost: 2600, inStock: true, server: 'server1', id: 's1', name: 'Telegram' }]);
  });

  test('among duplicate names, keeps the cheapest IN-STOCK variant even if a cheaper out-of-stock one exists', async () => {
    const provider = fakeProvider(
      [
        { id: 'cheap-oos', name: 'Whatsapp' },
        { id: 'mid-instock', name: 'Whatsapp' },
        { id: 'expensive-instock', name: 'Whatsapp' }
      ],
      {
        'cheap-oos':          { cost: 500,  inStock: false, server: 'server1' },
        'mid-instock':        { cost: 1560, inStock: true,  server: 'server1' },
        'expensive-instock':  { cost: 2600, inStock: true,  server: 'server1' }
      }
    );
    const catalog = await buildCatalog(provider, 159, 'server1');
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe('mid-instock');
  });

  test('falls back to the cheapest variant when nothing is in stock', async () => {
    const provider = fakeProvider(
      [{ id: 'a', name: 'Signal' }, { id: 'b', name: 'Signal' }],
      {
        a: { cost: 910, inStock: false, server: 'server1' },
        b: { cost: 500, inStock: false, server: 'server1' }
      }
    );
    const catalog = await buildCatalog(provider, 159, 'server1');
    expect(catalog[0].id).toBe('b');
  });

  test('drops a variant whose price lookup failed (cost: null) without dropping the whole service', async () => {
    const provider = fakeProvider(
      [{ id: 'broken', name: 'Discord' }, { id: 'ok', name: 'Discord' }],
      {
        broken: { cost: null, inStock: false, server: 'server1' },
        ok:     { cost: 910,  inStock: true,  server: 'server1' }
      }
    );
    const catalog = await buildCatalog(provider, 159, 'server1');
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe('ok');
  });

  test('omits a service entirely when every variant failed to price', async () => {
    const provider = fakeProvider(
      [{ id: 'a', name: 'Ghost' }],
      { a: { cost: null, inStock: false, server: 'server1' } }
    );
    const catalog = await buildCatalog(provider, 159, 'server1');
    expect(catalog).toEqual([]);
  });

  test('different names never collapse into each other', async () => {
    const provider = fakeProvider(
      [{ id: 'a', name: 'Amazon / AWS' }, { id: 'b', name: 'AliExpress' }],
      {
        a: { cost: 910, inStock: true, server: 'server1' },
        b: { cost: 910, inStock: true, server: 'server1' }
      }
    );
    const catalog = await buildCatalog(provider, 159, 'server1');
    expect(catalog.map(c => c.name).sort()).toEqual(['AliExpress', 'Amazon / AWS']);
  });
});

describe('syncProviderProducts', () => {
  test('refuses to run without a confirmed priceToNaira function, before touching the database', async () => {
    await expect(syncProviderProducts({})).rejects.toThrow('priceToNaira');
    expect(supabase.from).not.toHaveBeenCalled();
  });

  // REGRESSION: the first real run against production disabled nothing,
  // because it filtered on api_provider = 'manual' — but seedProducts.js
  // sets api_provider: 'sureverifications' on every category, not just
  // this one, so old hand-picked rows and freshly-synced ones were
  // indistinguishable by that column. Both ended up live at once (two
  // "WhatsApp"-ish products at two different prices). The fix keys off
  // metadata.sureVerifications.serviceId instead — present only on rows
  // this sync itself has written.
  test('disables only OTP rows without sureVerifications metadata, not by api_provider', async () => {
    getProvider.mockReturnValue({
      getCountries: jest.fn().mockResolvedValue([{ id: 159, data: { iso2: 'NG' } }]),
      getServicesForCountry: jest.fn().mockResolvedValue([{ id: 'svc-1', name: 'Discord' }]),
      getServicePrice: jest.fn().mockResolvedValue({ cost: 910, inStock: true, server: 'server1' })
    });

    const log = queueSupabaseResults([
      { data: { id: 'cat-otp' }, error: null }, // categories select
      {
        // existing enabled OTP rows: one stale hand-picked row (no
        // sureVerifications metadata, whatever its api_provider is) and
        // one already-synced row from a prior run (has the metadata,
        // must survive)
        data: [
          { id: 'old-discord', metadata: {} },
          { id: 'already-synced', metadata: { sureVerifications: { serviceId: 'svc-1' } } }
        ],
        error: null
      },
      { error: null },                                  // update({enabled:false}).in('id', staleIds)
      { data: { id: 'already-synced' }, error: null },   // find-existing by serviceId -> matches
      { error: null }                                    // update(row).eq('id', existing.id)
    ]);

    const result = await syncProviderProducts({ priceToNaira: (raw) => raw * 2 });

    expect(result).toEqual({ created: 0, updated: 1, total: 1 });

    // The disable call must target exactly the stale row, never the one
    // that's already correctly synced — this is the exact bug from the
    // live run: it must NOT be keyed off api_provider.
    const disableCall = log.find(c => c.method === 'in');
    expect(disableCall.args).toEqual(['id', ['old-discord']]);

    // And the price actually used the confirmed formula (raw 910 * 2).
    const updateCall = log.find(c => c.method === 'update' && c.args[0]?.price != null);
    expect(updateCall.args[0].price).toBe(1820);
  });
});
