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
