// Supabase connection settings for the browser.
//
// The anon key is PUBLIC by design — it is embedded in every Supabase
// frontend app, and Row Level Security (enabled on every table) is what
// actually protects the data. Never put SUPABASE_SERVICE_ROLE_KEY here:
// that key bypasses RLS and belongs only in the backend's .env.
window.SUPABASE_URL = 'https://chhsrqazmzdwrtreskdp.supabase.co';
window.SUPABASE_ANON_KEY = 'REPLACE_WITH_ANON_KEY';

window.sb = window.supabase.createClient(
  window.SUPABASE_URL,
  window.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,      // keeps the session in localStorage
      autoRefreshToken: true,    // refreshes the access token before it expires
      detectSessionInUrl: true   // picks up tokens from password-reset / confirm links
    }
  }
);
