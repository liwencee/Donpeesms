/**
 * Converts between Postgres snake_case column names and the camelCase
 * shape the frontend already expects from the old Prisma-backed API.
 */
const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

const toCamelCase = (obj) => {
  if (Array.isArray(obj)) return obj.map(toCamelCase);
  if (obj === null || typeof obj !== 'object' || obj instanceof Date) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[snakeToCamel(k)] = (v !== null && typeof v === 'object' && !(v instanceof Date)) ? toCamelCase(v) : v;
  }
  return out;
};

const toSnakeCase = (obj) => {
  if (obj === null || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[camelToSnake(k)] = v;
  }
  return out;
};

module.exports = { toCamelCase, toSnakeCase };
