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
    // NOTE: Supabase's certificate chain includes a self-signed cert that Node.js doesn't
    // trust by default. `ssl: true` alone fails with SELF_SIGNED_CERT_IN_CHAIN.
    // Since this is a one-time manual script against the legitimate Supabase database,
    // rejectUnauthorized: false is acceptable here. For production client libraries,
    // always validate certificates.
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  console.log(`Found ${files.length} migration file(s): ${files.join(', ')}`);

  try {
    for (const file of files) {
      console.log(`Applying ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`  ✓ ${file} applied successfully.`);
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.message.includes('already exists')) {
          console.log(`  ⊘ ${file} already applied (skipped).`);
        } else {
          console.error(`  ✗ ${file} failed:`, err.message);
          process.exitCode = 1;
        }
      }
    }
    console.log('Migration run completed.');
  } finally {
    await client.end();
  }
}

main();
