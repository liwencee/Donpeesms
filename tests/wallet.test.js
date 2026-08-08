/**
 * Money-path tests.
 *
 * creditWallet / debitWallet / refundOrder are the only code in this
 * service that moves real money, and until now nothing covered them.
 * These lock in the two behaviours that have already been the subject of
 * production bugs:
 *
 *   1. the bonus must not be double-counted in the confirmation email
 *   2. a refund must never be applied twice, however many callers race
 *
 * Everything is mocked — this suite never touches Supabase.
 */
jest.mock('../config/supabase', () => ({
  supabase: {
    auth: { admin: { getUserById: jest.fn() } },
    from: jest.fn(),
    rpc: jest.fn()
  }
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const { supabase } = require('../config/supabase');
const wallet = require('../controllers/walletController');
const numberCtrl = require('../controllers/numberController');

const okEmail = () =>
  supabase.auth.admin.getUserById.mockResolvedValue({
    data: { user: { id: 'u1', email: 'buyer@example.com' } },
    error: null
  });

beforeEach(() => {
  jest.clearAllMocks();
  okEmail();
});

// ═════════════════════════════════════════════
describe('calculateBonus', () => {
  test('always returns 0 — bonuses are disabled', () => {
    expect(wallet.calculateBonus(10)).toBe(0);
    expect(wallet.calculateBonus(50000)).toBe(0);
    expect(wallet.calculateBonus(0)).toBe(0);
  });
});

// ═════════════════════════════════════════════
describe('debitWallet', () => {
  test("maps the RPC's 'Insufficient wallet balance' to a 400", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'Insufficient wallet balance' } });

    await expect(
      wallet.debitWallet({ userId: 'u1', amount: 5, orderId: 'o1', description: 'buy' })
    ).rejects.toMatchObject({ statusCode: 400, message: 'Insufficient wallet balance' });
  });

  test("maps the RPC's 'User not found' to a 404", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'User not found' } });

    await expect(
      wallet.debitWallet({ userId: 'nope', amount: 5 })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('any other RPC failure is a 500, not a silent success', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    await expect(wallet.debitWallet({ userId: 'u1', amount: 5 })).rejects.toMatchObject({ statusCode: 500 });
  });

  test('returns the new balance and transaction id on success', async () => {
    supabase.rpc.mockResolvedValue({ data: [{ new_balance: 12.5, transaction_id: 'tx1' }], error: null });

    const out = await wallet.debitWallet({ userId: 'u1', amount: 5, orderId: 'o1' });
    expect(out.user.walletBalance).toBe(12.5);
    expect(out.tx.id).toBe('tx1');
  });
});

// ═════════════════════════════════════════════
describe('creditWallet', () => {
  test("maps the RPC's 'User not found' to a 404", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'User not found' } });

    await expect(
      wallet.creditWallet({ userId: 'nope', amount: 10, bonus: 1, method: 'drexpay' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('any other RPC failure is a 500', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'deadlock detected' } });

    await expect(
      wallet.creditWallet({ userId: 'u1', amount: 10, method: 'drexpay' })
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  // REGRESSION: tx.amount must be the BASE top-up, excluding the bonus.
  // The confirmation email prints Amount and Bonus on separate lines, so
  // folding the bonus into `amount` overstates what the user paid.
  test('tx.amount is the base amount, NOT amount + bonus', async () => {
    supabase.rpc.mockResolvedValue({ data: [{ new_balance: 115, transaction_id: 'tx9' }], error: null });

    const { tx } = await wallet.creditWallet({
      userId: 'u1', amount: 100, bonus: 20, method: 'drexpay', externalId: 'cs_1'
    });

    expect(tx).toEqual({ id: 'tx9', amount: 100, bonusAmount: 20, balanceAfter: 115 });
    expect(tx.amount).not.toBe(120);
  });

  test('returns the account email so the webhooks can send a confirmation', async () => {
    supabase.rpc.mockResolvedValue({ data: [{ new_balance: 50, transaction_id: 'tx2' }], error: null });

    const { user } = await wallet.creditWallet({ userId: 'u1', amount: 50, method: 'drexpay' });
    expect(user).toEqual({ id: 'u1', walletBalance: 50, email: 'buyer@example.com' });
  });

  // The credit has already committed by the time we look the email up.
  // Losing the address must cost an email, never the money.
  test('still succeeds when the email lookup fails', async () => {
    supabase.rpc.mockResolvedValue({ data: [{ new_balance: 50, transaction_id: 'tx3' }], error: null });
    supabase.auth.admin.getUserById.mockResolvedValue({ data: null, error: { message: 'auth down' } });

    const { user, tx } = await wallet.creditWallet({ userId: 'u1', amount: 50, method: 'drexpay' });
    expect(user.walletBalance).toBe(50);
    expect(user.email).toBeUndefined();
    expect(tx.id).toBe('tx3');
  });
});

// ═════════════════════════════════════════════
describe('refundOrder (numberController._refundOrder)', () => {
  const order = {
    id: 'o1',
    orderId: 'DP-123',
    userId: 'u1',
    userCost: 7.5,
    status: 'expired',
    refundedAt: null
  };

  test('credits once on the happy path', async () => {
    supabase.rpc.mockResolvedValue({ data: [{ new_balance: 20, transaction_id: 'tx1' }], error: null });

    const out = await numberCtrl._refundOrder({ ...order }, 'No SMS received within window');

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('refund_order', expect.objectContaining({
      p_order_id: 'o1', p_user_id: 'u1', p_amount: 7.5, p_new_status: 'refunded'
    }));
    expect(out.tx.id).toBe('tx1');
  });

  // THE double-refund guard. The RPC claims the refund with
  // `update orders ... where refunded_at is null`; the loser of that
  // race gets an empty result set back. Reading data[0] here used to be
  // unconditional, so the loser would have crashed on undefined — and
  // before the RPC was made idempotent, it would have paid out twice.
  test('an already-refunded order (empty RPC result) does not credit again or crash', async () => {
    supabase.rpc.mockResolvedValue({ data: [], error: null });

    const out = await numberCtrl._refundOrder({ ...order }, 'No SMS received within window');

    expect(out).toBeUndefined();
    expect(supabase.rpc).toHaveBeenCalledTimes(1); // claimed, declined, no retry
  });

  test('a null RPC result is treated the same way', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: null });

    await expect(numberCtrl._refundOrder({ ...order }, 'expired')).resolves.toBeUndefined();
  });

  test('the fast path skips the RPC entirely when refundedAt is already set', async () => {
    const out = await numberCtrl._refundOrder({ ...order, refundedAt: new Date().toISOString() }, 'expired');

    expect(out).toBeUndefined();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("maps the RPC's 'User not found' to a 404, like credit/debit", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'User not found' } });

    await expect(
      numberCtrl._refundOrder({ ...order }, 'expired')
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('a cancelled order keeps its status (p_new_status stays null)', async () => {
    supabase.rpc.mockResolvedValue({ data: [{ new_balance: 20, transaction_id: 'tx4' }], error: null });

    await numberCtrl._refundOrder({ ...order, status: 'cancelled' }, 'User cancelled');

    expect(supabase.rpc).toHaveBeenCalledWith('refund_order', expect.objectContaining({ p_new_status: null }));
  });
});
