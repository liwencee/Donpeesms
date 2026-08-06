// Supabase connection settings for the browser.
//
// The anon key is PUBLIC by design — it is embedded in every Supabase
// frontend app, and Row Level Security (enabled on every table) is what
// actually protects the data. Never put SUPABASE_SERVICE_ROLE_KEY here:
// that key bypasses RLS and belongs only in the backend's .env.
window.SUPABASE_URL = 'https://chhsrqazmzdwrtreskdp.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNoaHNycWF6bXpkd3J0cmVza2RwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNDIzNzcsImV4cCI6MjA5NTgxODM3N30.CxyCaEymrZ7-_-IG1EG3FhQnxFnPGNhb2ClQ8J2juxY';

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
