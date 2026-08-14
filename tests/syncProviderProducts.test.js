/**
 * utils/syncProviderProducts.js — the part worth locking in with a test
 * is the dedup logic: SureVerifications lists the same service name
 * multiple times under different opaque ids (confirmed live: "Whatsapp"
 * four times, "Telegram" three times, on server1 alone), and picking the
 * wrong variant means either overpaying or listing something out of
 * stock as available.
 */
jest.mock('../config/supabase', () => ({ supabase: { from: jest.fn() } }));

const { buildCatalog, findCountryId, syncProviderProducts } = require('../utils/syncProviderProducts');

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
    const { supabase } = require('../config/supabase');
    await expect(syncProviderProducts({})).rejects.toThrow('priceToNaira');
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
