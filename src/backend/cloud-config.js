/* Gamevault Cloud (Supabase) endpoint for the shared artwork cache.
 * The publishable key is public by design: it ships in the app and only
 * allows what the database's RLS + grants allow (read the art cache, sign in
 * anonymously). Never put the secret / service_role key here.
 * Override for a local `supabase start` with GV_CLOUD_URL / GV_CLOUD_KEY,
 * or set GV_CLOUD_URL=off to run with no cloud at all.
 */
const DEFAULT_URL = 'https://vzflcbudwwfixgypowxd.supabase.co';
const DEFAULT_KEY = 'sb_publishable_f-kEypYhQa2_xXLxO5S7Kg_Ct4ArAqe';

function cloudConfig(env = process.env) {
  if (env.GV_CLOUD_URL === 'off') return { url: '', anonKey: '' };
  return {
    url: env.GV_CLOUD_URL || DEFAULT_URL,
    anonKey: env.GV_CLOUD_KEY || DEFAULT_KEY,
  };
}

module.exports = { cloudConfig };
