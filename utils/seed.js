/**
 * Database seeder — creates admin user + test data
 * Run: npm run seed
 * Run: npm run seed -- --fresh   (wipes all data first)
 */
require('dotenv').config();
const { supabase } = require('../config/supabase');
const logger = require('./logger');

const run = async () => {
  if (process.argv.includes('--fresh')) {
    logger.warn('Clearing database...');
    const { data: allProfiles, error: fetchErr } = await supabase.from('profiles').select('id');
    if (fetchErr) {
      logger.error('Failed to fetch profiles for wipe:', fetchErr.message);
      throw fetchErr;
    }
    let failCount = 0;
    for (const p of allProfiles || []) {
      const { error: delErr } = await supabase.auth.admin.deleteUser(p.id);
      if (delErr) {
        failCount++;
        logger.error(`Failed to delete user ${p.id}:`, delErr.message);
      }
    }
    if (failCount > 0) {
      logger.error(`Database wipe incomplete: ${failCount} user(s) failed to delete`);
    } else {
      logger.warn('Database cleared');
    }
  }

  const { data: existingUsers } = await supabase.auth.admin.listUsers({ perPage: 1000 });

  const adminExists = existingUsers.users.find(u => u.email === 'admin@donpeesms.com');
  if (!adminExists) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: 'admin@donpeesms.com',
      password: 'Admin1234!',
      email_confirm: true,
      user_metadata: { username: 'admin', first_name: 'Admin', last_name: 'User' }
    });
    if (error) throw error;
    await supabase.from('profiles').update({ role: 'admin', wallet_balance: 1600000, referral_code: 'admin0001' }).eq('id', data.user.id);
    logger.info(`✓ Admin created: admin@donpeesms.com / Admin1234!`);
  }

  const demoExists = existingUsers.users.find(u => u.email === 'demo@donpeesms.com');
  if (!demoExists) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: 'demo@donpeesms.com',
      password: 'Demo1234!',
      email_confirm: true,
      user_metadata: { username: 'johndoe', first_name: 'John', last_name: 'Doe' }
    });
    if (error) throw error;
    await supabase.from('profiles').update({ wallet_balance: 39200 }).eq('id', data.user.id);

    const { error: txErr } = await supabase.from('transactions').insert([
      { user_id: data.user.id, type: 'topup', amount: 40000, balance_after: 40000, method: 'drexpay', status: 'success', description: 'Initial top-up' },
      { user_id: data.user.id, type: 'purchase', amount: -800, balance_after: 39200, method: 'wallet', status: 'success', description: 'Demo purchase' }
    ]);
    if (txErr) throw txErr;

    logger.info(`✓ Demo user created: demo@donpeesms.com / Demo1234!`);
  }

  logger.info('✓ Seed complete');
  process.exit(0);
};

run().catch(err => {
  logger.error('Seed failed:', err);
  process.exit(1);
});
