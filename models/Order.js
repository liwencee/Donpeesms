/**
 * Order helpers
 * Controllers use prisma.order directly; import helpers from here.
 */

const generateOrderId = () =>
  'NV' + Math.floor(100000 + Math.random() * 900000) + Date.now().toString().slice(-4);

/** Milliseconds remaining before the order expires (0 when already past). */
const getTimeRemaining = (order) => {
  if (!order.expiresAt) return null;
  return Math.max(0, new Date(order.expiresAt).getTime() - Date.now());
};

module.exports = { generateOrderId, getTimeRemaining };
