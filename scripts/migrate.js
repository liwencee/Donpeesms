/**
 * One-time/idempotent schema migration runner.
 * Usage: node scripts/migrate.js
 * Reads DATABASE_URL from .env (the same Supabase Postgres connection
 * already used for direct-SQL access), applies every .sql file in
 * supabase/migrations/ in filename order, inside a single transaction.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — check your .env file.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  console.log(`Found ${files.length} migration file(s): ${files.join(', ')}`);

  try {
    await client.query('BEGIN');
    for (const file of files) {
      console.log(`Applying ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log('All migrations applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
