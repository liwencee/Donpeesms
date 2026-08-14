const { calculateUserPrice } = require('../services/smsProvider');

describe('calculateUserPrice', () => {
  test('applies the markup and NGN rate, rounded to whole naira', () => {
    // 10 * priceMarkup(1.4 default) * ngnRate(1600 default) = 22400
    expect(calculateUserPrice(10)).toBe(22400);
  });

  test('rounds to the nearest whole naira', () => {
    // 1 * 1.4 * 1600 = 2240 exactly; use a cost that doesn't land on a whole number pre-round
    expect(calculateUserPrice(0.333)).toBe(Math.round(0.333 * 1.4 * 1600));
  });
});

// ═════════════════════════════════════════════
// SureVerificationsProvider — getServicesForCountry / getServicePrice.
//
// Both were added after discovering the live API rejects the un-parameterized
// calls the rest of this file's methods make (getServices/getPrice send no
// country_id, and getPrice sends a lowercase name instead of the opaque
// service id the API actually requires) — confirmed against the real API,
// not from documentation, since SureVerifications doesn't publish any.
// ═════════════════════════════════════════════
describe('SureVerificationsProvider', () => {
  let get;

  beforeEach(() => {
    jest.resetModules();
    get = jest.fn();
    jest.doMock('axios', () => ({ create: () => ({ get }) }));
  });

  const makeProvider = () => {
    const { SureVerificationsProvider } = require('../services/smsProvider');
    return new SureVerificationsProvider();
  };

  test('getServicesForCountry sends country_id and returns the services array', async () => {
    get.mockResolvedValue({ data: { services: [{ id: 'abc', name: 'Whatsapp' }] } });
    const provider = makeProvider();

    const services = await provider.getServicesForCountry(159, 'server1');

    expect(get).toHaveBeenCalledWith('/server1/services', { params: { country_id: 159 } });
    expect(services).toEqual([{ id: 'abc', name: 'Whatsapp' }]);
  });

  test('getServicePrice (server1) reads the single price/stock shape', async () => {
    get.mockResolvedValue({ data: { price: { service: { id: 'abc', name: 'Whatsapp', stocks: null }, price: 1560 } } });
    const provider = makeProvider();

    const price = await provider.getServicePrice(159, 'abc', 'server1');

    expect(get).toHaveBeenCalledWith('/server1/price', { params: { country_id: 159, service: 'abc' } });
    expect(price).toEqual({ cost: 1560, inStock: true, server: 'server1' });
  });

  test('getServicePrice (server1) treats stocks:0 as out of stock', async () => {
    get.mockResolvedValue({ data: { price: { service: { id: 'abc', stocks: 0 }, price: 1560 } } });
    const provider = makeProvider();

    const price = await provider.getServicePrice(159, 'abc', 'server1');
    expect(price.inStock).toBe(false);
  });

  test('getServicePrice (server2) picks the cheapest in-stock tier from the array shape', async () => {
    get.mockResolvedValue({
      data: {
        prices: [
          { service: { id: 'am', stocks: 22 }, price: 1083.5, id: 1 },
          { service: { id: 'am', stocks: 0 },  price: 900,    id: 2 }, // cheaper but out of stock — must be skipped
          { service: { id: 'am', stocks: 4 },  price: 1200,   id: 3 }
        ]
      }
    });
    const provider = makeProvider();

    const price = await provider.getServicePrice(159, 'am', 'server2');
    expect(price).toEqual({ cost: 1083.5, inStock: true, server: 'server2' });
  });

  test('getServicePrice (server2) reports out of stock when every tier is', async () => {
    get.mockResolvedValue({ data: { prices: [{ service: { id: 'am', stocks: 0 }, price: 900, id: 1 }] } });
    const provider = makeProvider();

    const price = await provider.getServicePrice(159, 'am', 'server2');
    expect(price).toEqual({ cost: null, inStock: false, server: 'server2' });
  });

  test('getServicePrice never throws — a provider error becomes {cost:null, inStock:false}', async () => {
    get.mockRejectedValue(new Error('network blip'));
    const provider = makeProvider();

    await expect(provider.getServicePrice(159, 'abc', 'server1')).resolves.toEqual({
      cost: null, inStock: false, server: 'server1'
    });
  });
});
