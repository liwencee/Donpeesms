const { toCamelCase, toSnakeCase } = require('../utils/caseMapper');

describe('toCamelCase', () => {
  test('converts snake_case keys to camelCase', () => {
    expect(toCamelCase({ first_name: 'A', wallet_balance: 10 }))
      .toEqual({ firstName: 'A', walletBalance: 10 });
  });

  test('recurses into nested objects and arrays', () => {
    expect(toCamelCase({ order_id: 'x', category: { sort_order: 1 } }))
      .toEqual({ orderId: 'x', category: { sortOrder: 1 } });
    expect(toCamelCase([{ user_id: '1' }, { user_id: '2' }]))
      .toEqual([{ userId: '1' }, { userId: '2' }]);
  });

  test('passes through null and non-object values unchanged', () => {
    expect(toCamelCase(null)).toBeNull();
    expect(toCamelCase(5)).toBe(5);
  });

  test('does not mangle Date instances', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(toCamelCase({ created_at: d }).createdAt).toBe(d);
  });
});

describe('toSnakeCase', () => {
  test('converts camelCase keys to snake_case', () => {
    expect(toSnakeCase({ firstName: 'A', walletBalance: 10 }))
      .toEqual({ first_name: 'A', wallet_balance: 10 });
  });

  test('passes through null unchanged', () => {
    expect(toSnakeCase(null)).toBeNull();
  });
});
