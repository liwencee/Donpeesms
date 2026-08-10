/**
 * Product catalog seeder — creates the default categories + products if
 * they don't already exist. Idempotent (safe to re-run): skips any
 * category/product that already exists by slug/name.
 *
 * Run: node utils/seedProducts.js
 *
 * Why this exists: the products/categories tables were wiped once already
 * when a schema migration recreated them without a data-migration step
 * (see supabase/migrations/0001_init.sql). This script is the recovery
 * path — re-run it any time the catalog comes back empty after a
 * migration, instead of re-typing 14 products by hand in the admin UI.
 *
 * Prices are NATIVE NAIRA (this backend is NGN-native post-DrexPay
 * migration; admin-managed product prices are entered directly in Naira,
 * see public/app.js fmtNGN()).
 */
require('dotenv').config();
const { supabase } = require('../config/supabase');
const logger = require('./logger');

const CATEGORIES = [
  { name: 'One-Time OTP',   slug: 'otp',    icon: '📱', sort_order: 1 },
  { name: 'Number Rentals', slug: 'rental', icon: '📅', sort_order: 2 },
  { name: 'Developer API',  slug: 'api',    icon: '🔌', sort_order: 3 }
];

const PRODUCTS = [
  { cat: 'otp', name: 'WhatsApp Number',    desc: 'Receive WhatsApp OTP instantly. 150+ countries.',      price: 128, color: '#25D366' },
  { cat: 'otp', name: 'Telegram Number',    desc: 'Verify Telegram accounts in seconds.',                 price: 80,  color: '#2CA5E0' },
  { cat: 'otp', name: 'Google / Gmail',     desc: 'OTP for Google sign-up and account recovery.',         price: 96,  color: '#4285F4' },
  { cat: 'otp', name: 'Instagram Number',   desc: 'Phone verification code for Instagram.',               price: 96,  color: '#E1306C' },
  { cat: 'otp', name: 'TikTok Number',      desc: 'Receive TikTok verification SMS.',                     price: 96,  color: '#FF0050' },
  { cat: 'otp', name: 'Twitter / X Number', desc: 'SMS verification for X account setup.',                price: 112, color: '#1D9BF0' },
  { cat: 'otp', name: 'Facebook Number',    desc: 'OTP code for Facebook phone verification.',            price: 112, color: '#1877F2' },
  { cat: 'otp', name: 'Any Service SMS',    desc: 'Works with any platform that sends an SMS code.',      price: 80,  color: '#8B5CF6' },
  { cat: 'rental', name: 'Number Rental — 1 Day',   desc: 'Keep one number for 24 hours, unlimited SMS.', price: 1920,  color: '#F59E0B' },
  { cat: 'rental', name: 'Number Rental — 7 Days',  desc: 'Weekly rental for repeat verifications.',      price: 9600,  color: '#F59E0B' },
  { cat: 'rental', name: 'Number Rental — 30 Days', desc: 'Long-term dedicated number for a month.',      price: 28800, color: '#F59E0B', stock: 5, stock_label: 'Limited' },
  { cat: 'api', name: 'Developer API — Starter',  desc: '1,000 verifications/month with REST API access.', price: 72000,  color: '#3B82F6' },
  { cat: 'api', name: 'Developer API — Growth',   desc: '5,000 verifications/month plus webhooks.',        price: 288000, color: '#3B82F6' },
  { cat: 'api', name: 'Developer API — Business', desc: 'Unlimited volume, priority routing, SLA.',        price: 672000, color: '#3B82F6', stock: 0, stock_label: 'Contact us' }
];

const run = async () => {
  const catMap = {};
  for (const c of CATEGORIES) {
    const { data, error } = await supabase.from('categories').upsert(c, { onConflict: 'slug' }).select().single();
    if (error) throw error;
    catMap[c.slug] = data.id;
  }
  logger.info(`✓ ${CATEGORIES.length} categories ready`);

  let created = 0;
  for (let i = 0; i < PRODUCTS.length; i++) {
    const pr = PRODUCTS[i];
    const { data: existing } = await supabase.from('products').select('id').eq('name', pr.name).maybeSingle();
    if (existing) continue;
    const { error } = await supabase.from('products').insert({
      name: pr.name,
      description: pr.desc,
      price: pr.price,
      color: pr.color,
      category_id: catMap[pr.cat],
      api_provider: 'sureverifications',
      stock: pr.stock ?? -1,
      stock_label: pr.stock_label ?? null,
      enabled: true,
      sort_order: i
    });
    if (error) throw error;
    created++;
  }
  logger.info(`✓ Products seeded: ${created} created, ${PRODUCTS.length - created} already existed`);
  process.exit(0);
};

run().catch((err) => {
  logger.error('Product seed failed:', err.message);
  process.exit(1);
});
