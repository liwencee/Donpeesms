/* ============================================================
   DonPeeSMS — App Logic (SPA)
   ============================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────
const state = {
  walletBalance: 0,
  selectedTopup: 10,
  activeDashSection: 'overview',
  orders: [],
  transactions: [],
  currentUser: null,
  activePollers: {}
};

// ── CURRENCY (Naira) ───────────────────────────────────────
// The backend stores and returns amounts in NGN directly — no conversion.
function fmtNaira(ngn, dp = 0) {
  const n = parseFloat(ngn) || 0;
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
// Signed variant for transactions: +₦.. / -₦..
function fmtNairaSigned(ngn, dp = 0) {
  const v = parseFloat(ngn) || 0;
  return (v >= 0 ? '+' : '-') + fmtNaira(Math.abs(v), dp);
}

// One-time sweep: convert any hard-coded "$N" text in the static HTML
// into Naira. Runs once on load; skips inputs, scripts and styles.
function nairaifyStaticText(root) {
  if (!root) return;
  const rx = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || node.nodeValue.indexOf('$') === -1) return NodeFilter.FILTER_REJECT;
      const tag = node.parentNode && node.parentNode.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let n; while ((n = walker.nextNode())) nodes.push(n);
  nodes.forEach(node => {
    node.nodeValue = node.nodeValue.replace(rx, (_m, num) => {
      const usd = parseFloat(num.replace(/,/g, ''));
      return fmtNaira(usd);
    });
  });
}

// ── API CLIENT ──────────────────────────────────────────────
// Auth is owned by Supabase: it stores the session in localStorage and
// refreshes the access token on its own. We never hold our own token —
// we ask for the current one on every request, so a token refreshed in
// the background is picked up immediately.
const API_BASE = '/api';

async function _accessToken() {
  try {
    const { data } = await window.sb.auth.getSession();
    return data?.session?.access_token || null;
  } catch (_e) {
    return null;
  }
}

async function api(method, path, body, timeoutMs = 15000) {
  const headers = { 'Content-Type': 'application/json' };
  const token = await _accessToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      signal: controller.signal,
      body: body ? JSON.stringify(body) : undefined
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    // A 401 now means the Supabase token was rejected by our backend —
    // the session is genuinely dead (Supabase already had its chance to
    // refresh it in _accessToken above), so sign out. Throw rather than
    // return null: callers that do `(await api(...))?.items || []` would
    // otherwise silently render an empty list, making a dead session look
    // like "no data" (this hid the admin panel showing "No products yet"
    // while 14 products existed).
    if (res.status === 401 && token) {
      await _handleUnauth();
      throw new Error('Your session expired. Please sign in again.');
    }
    if (!res.ok) throw new Error(data.message || data.error || 'Request failed (' + res.status + ')');
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Request timed out. Check your connection or try again.');
    if (err.message !== 'UNAUTHENTICATED') throw err;
    return null;
  }
}

async function _handleUnauth() {
  try { await window.sb.auth.signOut(); } catch (_e) {}
  state.currentUser = null;
  showPage('login');
  showToast('Session expired. Please sign in again.', 'warning');
}

// ── URL ROUTING (History API) ──────────────────────────────
// Keeps the address bar in sync with the current page so every screen
// has its own shareable URL and the browser back/forward buttons work.
let _suppressUrl = false;
const LANDING_PATHS = {
  home:'/', features:'/features', howitworks:'/how-it-works',
  services:'/services', products:'/products', pricing:'/pricing',
  faq:'/faq', contact:'/contact'
};
const PATH_TO_LANDING = {};
Object.entries(LANDING_PATHS).forEach(([sec, p]) => { PATH_TO_LANDING[p] = sec; });
const PAGE_PATHS = { login:'/login', register:'/register', dashboard:'/dashboard', admin:'/admin', 'admin-login':'/admin', 'forgot-password':'/forgot-password', 'reset-password':'/reset-password' };

function _setUrl(path) {
  if (_suppressUrl) return;
  const clean = path || '/';
  if (window.location.pathname !== clean) history.pushState({}, '', clean);
}

// Render the page that matches the current URL (used on load + back/forward).
function route() {
  const raw = window.location.pathname.replace(/\/+$/, '') || '/';
  // Path matching is case-insensitive (e.g. /ADMIN must route the same
  // as /admin) — lowercase every segment before comparing.
  const parts = raw.split('/').filter(Boolean).map(s => s.toLowerCase());
  _suppressUrl = true;
  try {
    if (parts.length === 0) { showPage('landing'); showLandingPage('home'); }
    else if (parts[0] === 'login')    showPage('login');
    else if (parts[0] === 'register') showPage('register');
    else if (parts[0] === 'forgot-password') showPage('forgot-password');
    else if (parts[0] === 'reset-password')  showPage('reset-password');
    else if (parts[0] === 'verify-email') { showPage('verify-email'); verifyEmailFromUrl(); }
    else if (parts[0] === 'admin')    showPage('admin'); // guard redirects non-admins
    else if (parts[0] === 'dashboard') {
      if (!state.currentUser) { showPage('login'); }
      else {
        showPage('dashboard');
        const sec = parts[1] || 'overview';
        if (dashSections.includes(sec) && sec !== 'overview') dashNav(sec);
      }
    }
    else if (PATH_TO_LANDING['/' + parts[0]]) {
      showPage('landing'); showLandingPage(PATH_TO_LANDING['/' + parts[0]]);
    }
    else { showPage('landing'); showLandingPage('home'); }
  } finally {
    _suppressUrl = false;
  }
}
window.addEventListener('popstate', route);

// ── PAGE ROUTER ────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + name);
  if (target) {
    target.classList.add('active');
    window.scrollTo(0, 0);
  }
  if (name === 'dashboard') initDashboard();
  if (name === 'admin') {
    // Hard guard: only an authenticated admin-role user may view the panel.
    if (!state.currentUser || state.currentUser.role !== 'admin') {
      target?.classList.remove('active');
      showPage('admin-login');
      return;
    }
    setTimeout(() => {
      initAdminCharts();
      buildAdminUsers();
      buildAdminPricing();
      buildAdminOrders();
    }, 100);
  }
  // Sync the URL (landing sub-pages are handled by showLandingPage).
  if (name !== 'landing' && PAGE_PATHS[name] !== undefined) _setUrl(PAGE_PATHS[name]);
}

// ── ADMIN AUTH ─────────────────────────────────────────────
async function handleAdminLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('adminLoginBtn');
  const email    = document.getElementById('adminEmail')?.value?.trim();
  const password = document.getElementById('adminPassword')?.value;
  if (!email || !password) return showToast('Enter email and password', 'warning');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Verifying...';
  try {
    const { data: authData, error } = await window.sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message || 'Invalid email or password');
    if (!authData.session) throw new Error('Sign-in did not return a session');

    let me;
    try {
      me = await api('GET', '/users/me');
    } catch (_e) {
      await window.sb.auth.signOut().catch(() => {});
      throw new Error('Signed in, but could not verify admin access. Please try again.');
    }
    if (!me) return;
    const user = me.user || me;
    if (user.role !== 'admin') {
      // Signed in successfully, but not an admin — drop the session so a
      // non-admin isn't left silently logged in on the admin screen.
      await window.sb.auth.signOut().catch(() => {});
      state.currentUser = null;
      showToast('This account does not have admin access.', 'error');
      return;
    }
    state.currentUser = user;
    showPage('admin');
    showToast('Welcome back, Admin 🛡️', 'success');
  } catch (err) {
    showToast(err.message || 'Admin login failed', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In to Admin';
  }
}

async function adminLogout() {
  try { await window.sb.auth.signOut(); } catch (_e) {}
  state.currentUser = null;
  showPage('admin-login');
  showToast('Signed out of admin', 'info');
}

// ── NAVBAR SCROLL ──────────────────────────────────────────
window.addEventListener('scroll', () => {
  const nav = document.getElementById('mainNav');
  if (nav) nav.classList.toggle('scrolled', window.scrollY > 40);
});

// ── LANDING PAGE ROUTER ─────────────────────────────────────
// Shows one landing sub-page (home/features/howitworks/services/pricing/faq)
// and hides all others — no scroll, true separate pages.
function showLandingPage(section) {
  const pages = ['home','features','howitworks','services','products','pricing','faq','contact'];

  pages.forEach(id => {
    const el = document.getElementById('lp-' + id);
    if (el) el.classList.toggle('hidden', id !== section);
  });

  // Trigger fade-in on visible page
  const target = document.getElementById('lp-' + section);
  if (target) {
    target.classList.remove('lp-fade');
    void target.offsetWidth; // force reflow
    target.classList.add('lp-fade');
  }

  // Update active nav link
  document.querySelectorAll('.nav-link[data-section]').forEach(link => {
    link.classList.toggle('active', link.getAttribute('data-section') === section);
  });

  // Always scroll to top of page when switching sections
  window.scrollTo({ top: 0, behavior: 'instant' });

  // Re-init FAQ if switching to that page (in case DOM wasn't ready)
  if (section === 'faq' && !document.querySelector('#faqList .faq-item')) {
    buildFAQ();
  }

  // Sync the URL to this landing sub-page.
  _setUrl(LANDING_PATHS[section] || '/');
}

function navScrollTo(id) { showLandingPage(id); }

// ── MOBILE NAV ─────────────────────────────────────────────
function openMobileNav() {
  document.getElementById('mobileNav').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeMobileNav() {
  document.getElementById('mobileNav').classList.remove('open');
  document.body.style.overflow = '';
}

// ── SIDEBAR ────────────────────────────────────────────────
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ── DASHBOARD NAVIGATION ───────────────────────────────────
const dashSections = ['overview','buy-whatsapp','buy-sms','orders','wallet','transactions','profile','api','referral','webhooks','affiliate'];
const dashTitles = {
  'overview':       'Dashboard Overview',
  'buy-whatsapp':   'Buy WhatsApp Number',
  'buy-sms':        'Buy SMS Number',
  'orders':         'My Orders',
  'wallet':         'Wallet & Top Up',
  'transactions':   'Transactions',
  'profile':        'Profile Settings',
  'api':            'API Access',
  'referral':       'Referral Program',
  'webhooks':       'Webhooks',
  'affiliate':      'Affiliate Program'
};

function dashNav(section) {
  dashSections.forEach(s => {
    const el = document.getElementById('dash-' + s);
    if (el) el.classList.toggle('hidden', s !== section);
  });

  // Update sidebar active state
  document.querySelectorAll('.sidebar-link').forEach(el => {
    el.classList.remove('active');
    if (el.getAttribute('onclick') && el.getAttribute('onclick').includes("'" + section + "'")) {
      el.classList.add('active');
    }
  });

  const titleEl = document.getElementById('dashTitle');
  if (titleEl) titleEl.textContent = dashTitles[section] || 'Dashboard';

  state.activeDashSection = section;

  // Render section-specific data
  if (section === 'orders') renderAllOrders();
  if (section === 'wallet') renderTransactions();
  if (section === 'transactions') renderAllTransactions();

  // Sync the URL: /dashboard for overview, /dashboard/<section> otherwise.
  _setUrl(section === 'overview' ? '/dashboard' : '/dashboard/' + section);

  closeSidebar();
}

// ── AUTH HANDLERS ──────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const email    = document.getElementById('loginEmail')?.value?.trim();
  const password = document.getElementById('loginPassword')?.value;
  if (!email || !password) return showToast('Please fill in all fields', 'warning');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Signing in...';
  try {
    const { data: authData, error } = await window.sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message || 'Invalid email or password');
    if (!authData.session) throw new Error('Sign-in did not return a session');

    // Profile (name, wallet balance, role) lives in our own API, not in
    // the auth token.
    let me;
    try {
      me = await api('GET', '/users/me');
    } catch (_e) {
      await window.sb.auth.signOut().catch(() => {});
      throw new Error('Signed in, but could not load your profile. Please try again.');
    }
    if (!me) return;
    state.currentUser = me.user || me;
    await _loadAndRenderUser();
    showPage('dashboard');
    showToast('Welcome back, ' + (state.currentUser?.firstName || 'there') + '! 👋', 'success');
  } catch (err) {
    showToast(err.message || 'Login failed. Check your credentials.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In to Account';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById('regBtn');
  const firstName = document.getElementById('regFirstName')?.value?.trim();
  const lastName  = document.getElementById('regLastName')?.value?.trim();
  const username  = document.getElementById('regUsername')?.value?.trim();
  const email     = document.getElementById('regEmail')?.value?.trim();
  const password  = document.getElementById('regPassword')?.value;
  if (!firstName || !email || !password) return showToast('Please fill in all required fields', 'warning');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating account...';
  try {
    const { data: authData, error } = await window.sb.auth.signUp({
      email,
      password,
      options: {
        // These land in raw_user_meta_data, which the handle_new_user
        // trigger reads to populate the profiles row.
        data: {
          username:   username || email.split('@')[0],
          first_name: firstName,
          last_name:  lastName || ''
        }
      }
    });
    if (error) throw new Error(error.message || 'Registration failed');
    if (!authData.session) {
      // Only happens if email confirmation is enabled in the Supabase
      // dashboard; with it off (our configuration) signUp returns a
      // session immediately.
      showToast('Account created! Check your email to confirm before signing in.', 'success', 6000);
      return showPage('login');
    }

    let me;
    try {
      me = await api('GET', '/users/me');
    } catch (_e) {
      await window.sb.auth.signOut().catch(() => {});
      throw new Error('Account created, but could not load your profile. Please sign in.');
    }
    if (!me) return;
    state.currentUser = me.user || me;
    await _loadAndRenderUser();
    showPage('dashboard');
    showToast('Account created! 🎉 Welcome to DonPeeSMS.', 'success', 6000);
  } catch (err) {
    showToast(err.message || 'Registration failed. Try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Free Account';
  }
}

function socialLogin(provider) {
  showToast(`${provider} login coming soon!`, 'info');
}

async function handleLogout() {
  // Clear client state FIRST so the user is logged out even if the
  // network call hangs or fails.
  state.currentUser = null;
  state.orders = [];
  state.transactions = [];
  state.walletBalance = 0;
  try { await window.sb.auth.signOut(); } catch (_e) {}
  showPage('landing');
  showLandingPage('home');
  showToast('Signed out successfully', 'info');
}

// ── PASSWORD RESET ──────────────────────────────────────────
async function handleForgotPassword(e) {
  e.preventDefault();
  const btn = document.getElementById('forgotBtn');
  const email = document.getElementById('forgotEmail')?.value?.trim();
  if (!email) return showToast('Enter your email address', 'warning');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sending...';
  try {
    const { error } = await window.sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/reset-password'
    });
    if (error) throw new Error(error.message);
    // Deliberately not revealing whether the address is registered.
    showToast('If that email is registered, a reset link is on its way.', 'success', 6000);
    showPage('login');
  } catch (err) {
    showToast(err.message || 'Could not send reset email', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Reset Link';
  }
}

async function handleResetPassword(e) {
  e.preventDefault();
  const btn = document.getElementById('resetBtn');
  const password = document.getElementById('resetPassword')?.value;
  const confirm  = document.getElementById('resetConfirm')?.value;
  if (!password || password.length < 8) return showToast('Password must be at least 8 characters', 'warning');
  if (password !== confirm) return showToast('Passwords do not match', 'warning');

  // Arriving from the emailed link puts a recovery session in place
  // (detectSessionInUrl consumed it); without one, the link is stale.
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) {
    showToast('This reset link has expired. Please request a new one.', 'error', 6000);
    return showPage('forgot-password');
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Updating...';
  try {
    const { error } = await window.sb.auth.updateUser({ password });
    if (error) throw new Error(error.message);
    showToast('Password updated — you are now signed in.', 'success');
    const me = await api('GET', '/users/me');
    if (me) { state.currentUser = me.user || me; await _loadAndRenderUser(); }
    showPage('dashboard');
  } catch (err) {
    showToast(err.message || 'Could not update password', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Password';
  }
}

// ── EMAIL VERIFICATION ─────────────────────────────────────
async function verifyEmailFromUrl() {
  const iconEl  = document.getElementById('verifyIcon');
  const titleEl = document.getElementById('verifyTitle');
  const msgEl   = document.getElementById('verifyMsg');
  const actsEl  = document.getElementById('verifyActions');
  const btnEl   = document.getElementById('verifyActionBtn');

  const ICONS = {
    success: '<svg width="34" height="34" fill="none" stroke="#34D399" stroke-width="2.5" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>',
    error:   '<svg width="34" height="34" fill="none" stroke="#F87171" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>'
  };
  const setState = (type, title, msg, bg) => {
    if (iconEl)  { iconEl.innerHTML = ICONS[type] || ''; iconEl.style.background = bg; }
    if (titleEl) titleEl.textContent = title;
    if (msgEl)   msgEl.textContent = msg;
  };

  // Supabase handles the token itself and redirects back here with the
  // session in the URL fragment; detectSessionInUrl consumes it before
  // this runs. So the question is simply: are we signed in now?
  const { data: { session } } = await window.sb.auth.getSession();
  const errorDescription = new URLSearchParams(window.location.hash.slice(1)).get('error_description');

  if (errorDescription) {
    setState('error', 'Verification failed', decodeURIComponent(errorDescription.replace(/\+/g, ' ')), 'rgba(248,113,113,.15)');
    if (actsEl) {
      actsEl.style.display = 'block';
      btnEl.textContent = 'Resend Email';
      btnEl.onclick = () => resendVerification();
    }
    return;
  }

  if (!session) {
    setState('error', 'Invalid or expired link', 'This verification link is no longer valid. Sign in and request a new one.', 'rgba(248,113,113,.15)');
    if (actsEl) { actsEl.style.display = 'block'; btnEl.textContent = 'Go to Login'; btnEl.onclick = () => showPage('login'); }
    return;
  }

  setState('success', 'Email verified! 🎉', 'Your account is now verified. You can use all features.', 'rgba(52,211,153,.15)');
  const me = await api('GET', '/users/me').catch(() => null);
  if (me) { state.currentUser = me.user || me; _loadAndRenderUser(); }
  if (actsEl) {
    actsEl.style.display = 'block';
    btnEl.textContent = 'Go to Dashboard';
    btnEl.onclick = () => showPage('dashboard');
  }
}

// Resend the verification email (requires being logged in).
async function resendVerification() {
  if (!state.currentUser) { showToast('Please sign in first to resend', 'warning'); return showPage('login'); }
  try {
    const email = state.currentUser?.email;
    if (!email) { showToast('Could not determine your email address', 'error'); return; }
    const { error } = await window.sb.auth.resend({ type: 'signup', email });
    if (error) throw new Error(error.message);
    showToast('Verification email sent — check your inbox', 'success', 5000);
  } catch (err) {
    showToast(err.message || 'Could not resend verification email', 'error');
  }
}

// ── USER PROFILE ────────────────────────────────────────────
async function _loadAndRenderUser() {
  try {
    if (!state.currentUser) {
      const data = await api('GET', '/users/me');
      if (!data) return;
      state.currentUser = data.user || data;
    }
    const u = state.currentUser;
    const initials = ((u.firstName?.[0] || '') + (u.lastName?.[0] || '') || u.email?.[0] || '?').toUpperCase();
    const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.email;

    // Topbar
    const av = document.getElementById('topbarAvatar');
    const nm = document.getElementById('topbarName');
    const em = document.getElementById('topbarEmail');
    if (av) av.textContent = initials;
    if (nm) nm.textContent = fullName;
    if (em) em.textContent = u.email;

    // Profile page
    const pAv = document.getElementById('profileAvatar');
    const pFN = document.getElementById('profileFullName');
    const pED = document.getElementById('profileEmailDisplay');
    const pVB = document.getElementById('profileVerifiedBadge');
    if (pAv) pAv.textContent = initials;
    if (pFN) pFN.textContent = fullName;
    if (pED) pED.textContent = u.email;
    if (pVB) {
      // Email confirmation is owned by Supabase Auth, not our profiles
      // table — read it off the session rather than the API response.
      const { data: { user: authUser } } = await window.sb.auth.getUser();
      const verified = !!authUser?.email_confirmed_at;
      pVB.textContent = verified ? 'Verified Account' : 'Email Not Verified';
      pVB.className = verified ? 'badge badge-success' : 'badge';
      pVB.style.cssText = verified ? '' : 'background:rgba(245,158,11,.15);color:var(--warning);cursor:pointer';
      pVB.title = verified ? '' : 'Click to resend verification email';
      pVB.onclick = verified ? null : () => resendVerification();
    }

    const pfn = document.getElementById('profileFirstName');
    const pln = document.getElementById('profileLastName');
    const pe  = document.getElementById('profileEmail');
    const pun = document.getElementById('profileUsername');
    const ptg = document.getElementById('profileTelegram');
    if (pfn) pfn.value = u.firstName || '';
    if (pln) pln.value = u.lastName  || '';
    if (pe)  pe.value  = u.email     || '';
    if (pun) pun.value = u.username  || '';
    if (ptg) ptg.value = u.telegram  || '';

    // Wallet balance
    state.walletBalance = parseFloat(u.walletBalance || 0);
    updateWalletDisplay();

    // Referral links (real code, no dummy username)
    const code = u.referralCode || u.username || '';
    const setLink = (id, url) => { const el = document.getElementById(id); if (el) el.textContent = url; };
    if (code) {
      setLink('refLinkLanding',  'https://donpeesms.com/?ref=' + code);
      setLink('refLinkRegister', 'https://donpeesms.com/register?ref=' + code);
      setLink('refLinkSimple',   'https://donpeesms.com/ref/' + code);
    }
  } catch (err) {
    console.error('_loadAndRenderUser:', err.message);
  }
}

async function saveProfile() {
  const btn = document.getElementById('saveProfileBtn');
  const firstName = document.getElementById('profileFirstName')?.value?.trim();
  const lastName  = document.getElementById('profileLastName')?.value?.trim();
  const telegram  = document.getElementById('profileTelegram')?.value?.trim();
  if (!firstName) return showToast('First name is required', 'warning');

  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    const data = await api('PATCH', '/users/me', { firstName, lastName, telegram });
    if (!data) return;
    state.currentUser = { ...state.currentUser, firstName, lastName, telegram };
    await _loadAndRenderUser();
    showToast('Profile updated successfully!', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to save profile', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

// ── PROFILE TABS ───────────────────────────────────────────
// Switch between Personal Info / Security / Notifications / Payments.
function profileTab(tab, el) {
  document.querySelectorAll('#dash-profile .settings-panel').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById('settings-' + tab);
  if (panel) panel.classList.remove('hidden');
  document.querySelectorAll('#dash-profile .settings-nav-item').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
}

async function changePassword() {
  const btn = document.getElementById('changePassBtn');
  const currentPassword = document.getElementById('curPassword')?.value;
  const newPassword     = document.getElementById('newPassword')?.value;
  const confirm         = document.getElementById('confirmPassword')?.value;
  if (!currentPassword || !newPassword) return showToast('Fill in all password fields', 'warning');
  if (newPassword.length < 6) return showToast('New password must be at least 6 characters', 'warning');
  if (newPassword !== confirm) return showToast('New passwords do not match', 'warning');

  btn.disabled = true;
  btn.textContent = 'Updating...';
  try {
    // Supabase's updateUser() does not check the current password, so
    // verify it by re-authenticating before allowing the change.
    const email = state.currentUser?.email;
    if (!email) throw new Error('Could not determine your email address');

    const { error: reauthError } = await window.sb.auth.signInWithPassword({ email, password: currentPassword });
    if (reauthError) throw new Error('Current password is incorrect');

    const { error } = await window.sb.auth.updateUser({ password: newPassword });
    if (error) throw new Error(error.message || 'Failed to update password');

    showToast('Password updated successfully', 'success');
    ['curPassword', 'newPassword', 'confirmPassword'].forEach(id => {
      const f = document.getElementById(id); if (f) f.value = '';
    });
  } catch (err) {
    showToast(err.message || 'Failed to update password', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Password';
  }
}

// ── AUTO-AUTH ON LOAD ────────────────────────────────────────
async function initAuth() {
  // Resolve the session first, then render the page matching the URL.
  const { data: { session } } = await window.sb.auth.getSession();
  if (session) {
    try {
      const data = await api('GET', '/users/me');
      if (data) {
        state.currentUser = data.user || data;
        await _loadAndRenderUser();
      }
    } catch (_e) {
      await window.sb.auth.signOut().catch(() => {});
      state.currentUser = null;
    }
  }

  // Keep this tab in sync: fires on token refresh, and on sign-out
  // performed in another tab.
  window.sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && state.currentUser) {
      state.currentUser = null;
      showPage('login');
    }
  });

  route();
}

// ── TOGGLE PASSWORD ────────────────────────────────────────
function togglePass(id) {
  const input = document.getElementById(id);
  if (input) input.type = input.type === 'password' ? 'text' : 'password';
}

// ── TOAST NOTIFICATIONS ────────────────────────────────────
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer');
  const icons = {
    success: '<svg width="18" height="18" fill="none" stroke="#10B981" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>',
    error:   '<svg width="18" height="18" fill="none" stroke="#EF4444" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
    info:    '<svg width="18" height="18" fill="none" stroke="#8B5CF6" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    warning: '<svg width="18" height="18" fill="none" stroke="#F59E0B" stroke-width="2.5" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>'
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${icons[type] || icons.info}<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'all .3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── COPY TO CLIPBOARD ──────────────────────────────────────
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied to clipboard!', 'success', 2000);
  }).catch(() => {
    showToast('Copy failed. Please copy manually.', 'error');
  });
}

// ── BUY NUMBER (Quick Panel) ───────────────────────────────
async function buyNumber(type) {
  if (!state.currentUser) { showPage('login'); showToast('Please sign in first', 'warning'); return; }
  const countrySelect = document.getElementById(type === 'whatsapp' ? 'waCountry' : 'smsCountry');
  const serviceSelect = type === 'sms' ? document.getElementById('smsService') : null;
  const resultDiv     = document.getElementById(type === 'whatsapp' ? 'waResult'  : 'smsResult');
  const btn           = document.getElementById(type === 'whatsapp' ? 'buyWABtn'  : 'buySMSBtn');
  if (!countrySelect?.value) { showToast('Please select a country first', 'warning'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Finding number...';

  try {
    const data = await api('POST', '/numbers/buy', {
      serviceType: type,
      country: countrySelect.value,
      ...(serviceSelect?.value ? { service: serviceSelect.value } : {})
    });
    if (!data) return;

    const order  = data.order;
    const number = order.phoneNumber;
    const price  = order.cost;

    state.walletBalance = Math.max(0, state.walletBalance - price);
    updateWalletDisplay();

    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = `
      <div class="number-result">
        <div>
          <div style="font-size:.75rem;color:var(--txt-4);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em">Your Number</div>
          <div class="number-display">${number}</div>
          <div id="otpDisplay-${order.id}" style="margin-top:8px;font-size:.85rem;color:var(--txt-3)">
            <span class="pulse-ring"></span> Waiting for ${type === 'whatsapp' ? 'WhatsApp OTP' : 'SMS'}...
            <span id="timer-${order.id}">20:00</span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <button class="copy-btn" onclick="copyText('${number}')">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            Copy
          </button>
          <button class="copy-btn" style="color:var(--error)" onclick="cancelOrder('${order.id}')">Cancel</button>
        </div>
      </div>`;

    startTimer('timer-' + order.id, Math.floor((order.timeRemainingMs || 1200000) / 1000));
    _pollOrder(order.id, type);

    // refresh orders list
    loadRecentOrders();
    showToast(`${type === 'whatsapp' ? 'WhatsApp' : 'SMS'} number assigned! Waiting for OTP...`, 'success');
  } catch (err) {
    showToast(err.message || 'Failed to get number. Try again.', 'error');
    if (err.message?.toLowerCase().includes('balance')) openTopupModal();
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Get Another Number';
  }
}

function _pollOrder(orderId, type) {
  if (state.activePollers[orderId]) return;
  let attempts = 0;
  state.activePollers[orderId] = setInterval(async () => {
    attempts++;
    try {
      const data = await api('GET', '/numbers/orders/' + orderId + '/status');
      if (!data) return;
      const o = data.order;
      if (o.otpCode) {
        clearInterval(state.activePollers[orderId]);
        delete state.activePollers[orderId];
        const otpEl = document.getElementById('otpDisplay-' + orderId);
        if (otpEl) {
          otpEl.innerHTML = `
            <div style="font-size:.75rem;color:var(--txt-4);margin-bottom:6px;text-transform:uppercase"><span class="pulse-ring"></span> OTP Received</div>
            <div class="otp-display">${o.otpCode}</div>
            <div style="text-align:center;margin-top:8px">
              <button class="copy-btn" style="margin:0 auto" onclick="copyText('${o.otpCode}')">Copy OTP</button>
            </div>`;
        }
        showToast('OTP received: ' + o.otpCode, 'success', 6000);
        loadRecentOrders();
        // refresh balance
        const me = await api('GET', '/users/me');
        if (me) { state.walletBalance = me.user?.walletBalance || state.walletBalance; updateWalletDisplay(); }
      } else if (['cancelled','expired','refunded'].includes(o.status)) {
        clearInterval(state.activePollers[orderId]);
        delete state.activePollers[orderId];
        loadRecentOrders();
      }
    } catch (_e) {}
    if (attempts >= 40) { clearInterval(state.activePollers[orderId]); delete state.activePollers[orderId]; }
  }, 5000);
}

async function cancelOrder(orderId) {
  try {
    await api('POST', '/numbers/orders/' + orderId + '/cancel');
    if (state.activePollers[orderId]) { clearInterval(state.activePollers[orderId]); delete state.activePollers[orderId]; }
    showToast('Order cancelled and refunded to wallet', 'info');
    loadRecentOrders();
    const me = await api('GET', '/users/me');
    if (me) { state.walletBalance = me.user?.walletBalance || state.walletBalance; updateWalletDisplay(); }
  } catch (err) {
    showToast(err.message || 'Cancel failed', 'error');
  }
}

// Full page buy (dedicated sections)
function buyNumberFull(type) {
  showToast(`Processing ${type} number request...`, 'info');
  setTimeout(() => {
    dashNav('overview');
    setTimeout(() => {
      const btn = document.getElementById(type === 'whatsapp' ? 'buyWABtn' : 'buySMSBtn');
      if (btn) {
        showToast(`Switched to quick buy panel. Select your country.`, 'info');
      }
    }, 300);
  }, 500);
}

// ── COUNTDOWN TIMER ────────────────────────────────────────
function startTimer(elId, seconds) {
  let remaining = seconds;
  const interval = setInterval(() => {
    remaining--;
    const el = document.getElementById(elId);
    if (!el || remaining <= 0) {
      clearInterval(interval);
      if (el) el.textContent = 'Expired';
      return;
    }
    const m = Math.floor(remaining / 60).toString().padStart(2, '0');
    const s = (remaining % 60).toString().padStart(2, '0');
    el.textContent = `${m}:${s}`;
  }, 1000);
}

// ── WALLET ─────────────────────────────────────────────────
function updateWalletDisplay() {
  const naira = fmtNaira(state.walletBalance);
  const el = document.getElementById('sidebarBalance');
  if (el) el.textContent = naira;
  // Overview stat card
  const stats = document.querySelectorAll('.stat-card-value');
  if (stats[0]) stats[0].textContent = naira;
  // Wallet page balance
  const wp = document.getElementById('walletPageBalance');
  if (wp) wp.textContent = naira;
  // Dashboard balance stat (if present)
  const sb = document.getElementById('statBalance');
  if (sb) sb.textContent = naira;
}

function selectTopup(el, amount) {
  el.closest('.topup-grid').querySelectorAll('.topup-amount-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  state.selectedTopup = amount;

  const customWrap = document.getElementById('customAmountWrap');
  if (customWrap) customWrap.classList.toggle('hidden', amount !== 'custom');

  if (amount === 'custom') {
    updateTopupSummary(parseFloat(document.getElementById('customAmount')?.value || 0));
  } else {
    updateTopupSummary(parseFloat(amount));
  }
}

function updateTopupSummary(amount) {
  const amtEl = document.getElementById('modalAmountDisplay');
  if (amtEl) amtEl.textContent = fmtNaira(amount);
}

// Live-update the summary when the user types a custom Naira amount.
function onCustomAmountInput(nairaVal) {
  updateTopupSummary(parseFloat(nairaVal) || 0);
}

function openTopupModal() {
  document.getElementById('topupModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeTopupModal() {
  document.getElementById('topupModal').classList.remove('open');
  document.body.style.overflow = '';
}

async function processTopup() {
  const amount = state.selectedTopup === 'custom'
    ? parseFloat(document.getElementById('customAmount')?.value || 0)
    : parseFloat(state.selectedTopup);

  if (!amount || amount < 1500) {
    showToast(`Please enter a valid amount (min ${fmtNaira(1500)})`, 'warning');
    return;
  }

  closeTopupModal();
  showToast('Redirecting to DrexPay...', 'info');

  try {
    const data = await api('POST', '/wallet/topup', { amount, method: 'drexpay' });
    if (!data) return;
    // DrexPay is the only payment provider (Stripe/PayPal/NowPayments were
    // removed alongside it) — its response nests the checkout link under
    // `payment.url`.
    const url = data.payment && data.payment.url;
    if (url) {
      window.open(url, '_blank');
      showToast('Complete payment in the new tab. Your balance updates automatically.', 'info', 6000);
    } else {
      showToast('Payment initiated. Your balance will update once confirmed.', 'success');
    }
  } catch (err) {
    showToast(err.message || 'Payment initiation failed. Try again.', 'error');
  }
}

// ── ORDERS ─────────────────────────────────────────────────
function _orderRow(o) {
  const svc     = (o.serviceType || o.service || '').toLowerCase();
  const isWA    = svc === 'whatsapp';
  const otp     = o.otpCode || (o.smsMessages?.[0]?.code) || '—';
  const cost    = o.userCost != null ? fmtNaira(o.userCost) : (o.cost || '—');
  const date    = o.createdAt ? new Date(o.createdAt).toLocaleString() : (o.date || '');
  const orderId = o.orderId || o.id || '';
  const country = o.country || '';
  const phone   = o.phoneNumber || o.number || '';
  const status  = o.status || 'pending';
  return `<tr>
    <td style="font-size:.82rem;color:var(--p-300)">#${orderId}</td>
    <td><div class="td-service">
      ${isWA
        ? '<img src="https://cdn.simpleicons.org/whatsapp/25D366" alt="WA" width="16" height="16" style="vertical-align:middle"/>'
        : '<svg width="16" height="16" fill="none" stroke="var(--p-400)" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>'}
      ${isWA ? 'WhatsApp' : 'SMS'}
    </div></td>
    <td class="td-number">${phone}</td>
    <td><span class="badge badge-purple" style="font-size:.7rem">${country}</span></td>
    <td class="td-amount">${cost}</td>
    <td style="font-size:.85rem;color:${otp !== '—' ? 'var(--success)' : 'var(--txt-4)'}">${otp}</td>
    <td>${statusBadge(status)}</td>
    <td style="color:var(--txt-4);font-size:.8rem">${date}</td>
  </tr>`;
}

function renderOrdersTable() {
  const tbody = document.getElementById('ordersBody');
  if (!tbody) return;
  if (!state.orders.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--txt-4);padding:32px">No orders yet. Buy your first number! 🚀</td></tr>';
    return;
  }
  tbody.innerHTML = state.orders.slice(0, 6).map(_orderRow).join('');
}

async function renderAllOrders() {
  const tbody = document.getElementById('allOrdersBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--txt-4);padding:24px"><span class="spinner"></span> Loading...</td></tr>';
  try {
    const data = await api('GET', '/numbers/orders?limit=50');
    if (!data) return;
    const orders = data.orders || [];
    if (!orders.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--txt-4);padding:32px">No orders yet.</td></tr>';
      return;
    }
    tbody.innerHTML = orders.map(_orderRow).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--error);padding:24px">Failed to load orders</td></tr>';
  }
}

function statusBadge(status) {
  const map = {
    completed: '<span class="badge badge-success">Completed</span>',
    pending:   '<span class="badge badge-warning">Pending OTP</span>',
    refunded:  '<span class="badge badge-info">Refunded</span>',
    failed:    '<span class="badge badge-error">Failed</span>'
  };
  return map[status] || '<span class="badge badge-purple">Unknown</span>';
}

function filterTable(query) {
  const rows = document.querySelectorAll('#ordersBody tr');
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(query.toLowerCase()) ? '' : 'none';
  });
}

// ── TRANSACTIONS ───────────────────────────────────────────
function _txRow(tx, showId) {
  const type   = tx.type || tx.transactionType || 'Transaction';
  const amt    = tx.amount != null ? fmtNairaSigned(tx.amount) : '—';
  const isPos  = parseFloat(tx.amount || 0) >= 0;
  const method = tx.method || tx.paymentMethod || 'Wallet';
  const bal    = tx.balanceAfter != null ? fmtNaira(tx.balanceAfter) : '—';
  const date   = tx.createdAt ? new Date(tx.createdAt).toLocaleString() : (tx.date || '');
  const status = tx.status || 'success';
  const typeClass = type.toLowerCase().includes('top') ? 'badge-success' : type.toLowerCase().includes('refund') ? 'badge-info' : 'badge-purple';
  const idCell = showId ? `<td style="font-size:.78rem;color:var(--p-300)">${tx.id || ''}</td>` : '';
  return `<tr>
    ${idCell}
    <td><span class="badge ${typeClass}">${type}</span></td>
    <td style="font-weight:700;color:${isPos ? 'var(--success)' : 'var(--error)'}">${amt}</td>
    <td style="color:var(--txt-3);font-size:.85rem">${method}</td>
    ${showId ? `<td style="color:var(--txt-3);font-size:.85rem">${bal}</td>` : ''}
    <td>${statusBadge2(status)}</td>
    <td style="color:var(--txt-4);font-size:.8rem">${date}</td>
  </tr>`;
}

function renderTransactions() {
  const tbody = document.getElementById('txBody');
  if (!tbody) return;
  if (!state.transactions.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--txt-4);padding:28px">No transactions yet.</td></tr>';
    return;
  }
  tbody.innerHTML = state.transactions.slice(0, 6).map(tx => _txRow(tx, false)).join('');
}

async function renderAllTransactions() {
  const tbody = document.getElementById('allTxBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--txt-4);padding:24px"><span class="spinner"></span> Loading...</td></tr>';
  try {
    const data = await api('GET', '/wallet/transactions?limit=100');
    if (!data) return;
    const txs = data.transactions || [];
    if (!txs.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--txt-4);padding:32px">No transactions yet.</td></tr>';
      return;
    }
    tbody.innerHTML = txs.map(tx => _txRow(tx, true)).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--error);padding:24px">Failed to load transactions</td></tr>';
  }
}

function statusBadge2(status) {
  return status === 'success' ? '<span class="badge badge-success">Success</span>' : '<span class="badge badge-error">Failed</span>';
}

// ── COUNTRIES SCROLL ───────────────────────────────────────
const countries = [
  { flag:'🇺🇸', name:'United States' }, { flag:'🇬🇧', name:'United Kingdom' },
  { flag:'🇩🇪', name:'Germany' },       { flag:'🇫🇷', name:'France' },
  { flag:'🇮🇳', name:'India' },         { flag:'🇧🇷', name:'Brazil' },
  { flag:'🇨🇦', name:'Canada' },        { flag:'🇦🇺', name:'Australia' },
  { flag:'🇷🇺', name:'Russia' },        { flag:'🇳🇬', name:'Nigeria' },
  { flag:'🇵🇰', name:'Pakistan' },      { flag:'🇮🇩', name:'Indonesia' },
  { flag:'🇹🇷', name:'Turkey' },        { flag:'🇲🇽', name:'Mexico' },
  { flag:'🇵🇭', name:'Philippines' },   { flag:'🇻🇳', name:'Vietnam' },
  { flag:'🇺🇦', name:'Ukraine' },       { flag:'🇿🇦', name:'South Africa' },
  { flag:'🇪🇬', name:'Egypt' },         { flag:'🇸🇦', name:'Saudi Arabia' },
  { flag:'🇦🇪', name:'UAE' },           { flag:'🇯🇵', name:'Japan' },
  { flag:'🇰🇷', name:'South Korea' },   { flag:'🇲🇾', name:'Malaysia' },
  { flag:'🇸🇬', name:'Singapore' },     { flag:'🇹🇭', name:'Thailand' },
  { flag:'🇵🇱', name:'Poland' },        { flag:'🇳🇱', name:'Netherlands' },
  { flag:'🇧🇪', name:'Belgium' },       { flag:'🇦🇷', name:'Argentina' },
  { flag:'🇨🇴', name:'Colombia' },      { flag:'🇨🇱', name:'Chile' },
  { flag:'🇮🇷', name:'Iran' },          { flag:'🇮🇶', name:'Iraq' },
  { flag:'🇬🇭', name:'Ghana' },         { flag:'🇰🇪', name:'Kenya' },
  { flag:'🇪🇸', name:'Spain' },         { flag:'🇮🇹', name:'Italy' },
  { flag:'🇸🇪', name:'Sweden' },        { flag:'🇨🇭', name:'Switzerland' },
];

function buildCountriesScroll() {
  const track = document.getElementById('countriesTrack');
  if (!track) return;
  // Duplicate for infinite scroll
  const all = [...countries, ...countries];
  track.innerHTML = all.map(c => `
    <div class="country-chip">
      <span class="country-flag">${c.flag}</span>
      <span>${c.name}</span>
    </div>
  `).join('');
}

// ── APP CHIPS ──────────────────────────────────────────────
const apps = [
  { name:'WhatsApp', color:'#25D366' }, { name:'Telegram', color:'#2CA5E0' },
  { name:'Google', color:'#4285F4' },   { name:'Facebook', color:'#1877F2' },
  { name:'Instagram', color:'#E1306C' },{ name:'Twitter / X', color:'#1D9BF0' },
  { name:'TikTok', color:'#FF0050' },   { name:'Uber', color:'#000000' },
  { name:'Amazon', color:'#FF9900' },   { name:'PayPal', color:'#003087' },
  { name:'Microsoft', color:'#0078D4' },{ name:'Apple ID', color:'#555555' },
  { name:'Discord', color:'#5865F2' },  { name:'Snapchat', color:'#FFFC00' },
  { name:'LinkedIn', color:'#0A66C2' }, { name:'Spotify', color:'#1DB954' },
];

// ── PRODUCTS CATALOG ───────────────────────────────────────
// usd = provider-side price; displayed in Naira via fmtNaira().
const PRODUCTS = [
  // One-time OTP numbers
  { cat:'otp', name:'WhatsApp Number',    desc:'Receive WhatsApp OTP instantly. 150+ countries.',      usd:0.08, stock:'In stock', color:'#25D366' },
  { cat:'otp', name:'Telegram Number',    desc:'Verify Telegram accounts in seconds.',                 usd:0.05, stock:'In stock', color:'#2CA5E0' },
  { cat:'otp', name:'Google / Gmail',     desc:'OTP for Google sign-up and account recovery.',         usd:0.06, stock:'In stock', color:'#4285F4' },
  { cat:'otp', name:'Instagram Number',   desc:'Phone verification code for Instagram.',               usd:0.06, stock:'In stock', color:'#E1306C' },
  { cat:'otp', name:'TikTok Number',      desc:'Receive TikTok verification SMS.',                     usd:0.06, stock:'In stock', color:'#FF0050' },
  { cat:'otp', name:'Twitter / X Number', desc:'SMS verification for X account setup.',                usd:0.07, stock:'In stock', color:'#1D9BF0' },
  { cat:'otp', name:'Facebook Number',    desc:'OTP code for Facebook phone verification.',            usd:0.07, stock:'In stock', color:'#1877F2' },
  { cat:'otp', name:'Any Service SMS',    desc:'Works with any platform that sends an SMS code.',      usd:0.05, stock:'In stock', color:'#8B5CF6' },
  // Rentals
  { cat:'rental', name:'Number Rental — 1 Day',   desc:'Keep one number for 24 hours, unlimited SMS.', usd:1.20, stock:'In stock', color:'#F59E0B' },
  { cat:'rental', name:'Number Rental — 7 Days',  desc:'Weekly rental for repeat verifications.',      usd:6.00, stock:'In stock', color:'#F59E0B' },
  { cat:'rental', name:'Number Rental — 30 Days', desc:'Long-term dedicated number for a month.',      usd:18.00, stock:'Limited',  color:'#F59E0B' },
  // API / bulk
  { cat:'api', name:'Developer API — Starter',  desc:'1,000 verifications/month with REST API access.', usd:45.00, stock:'In stock', color:'#3B82F6' },
  { cat:'api', name:'Developer API — Growth',   desc:'5,000 verifications/month plus webhooks.',        usd:180.00, stock:'In stock', color:'#3B82F6' },
  { cat:'api', name:'Developer API — Business', desc:'Unlimited volume, priority routing, SLA.',        usd:420.00, stock:'Contact us', color:'#3B82F6' }
];

const PRODUCT_CATS = [
  { id:'all',    label:'All Products' },
  { id:'otp',    label:'One-Time OTP' },
  { id:'rental', label:'Number Rentals' },
  { id:'api',    label:'Developer API' }
];

let _activeProdCat = 'all';
let _liveCategories = null; // populated from /api/products/categories when available
let _liveProducts   = null; // populated from /api/products when available

// Fetch admin-managed products/categories once; fall back to the static
// catalog above if the API has nothing yet (e.g. fresh install).
async function loadLiveProducts() {
  try {
    const [prodRes, catRes] = await Promise.all([
      api('GET', '/products'),
      api('GET', '/products/categories')
    ]);
    if (prodRes?.products?.length) _liveProducts = prodRes.products;
    if (catRes?.categories?.length) _liveCategories = catRes.categories;
  } catch (_e) {
    // API not reachable / no products yet — static catalog is used instead.
  }
  buildProductFilters();
  buildProducts();
}

function buildProductFilters() {
  const el = document.getElementById('prodFilters');
  if (!el) return;
  const cats = _liveCategories
    ? [{ id: 'all', label: 'All Products' }, ..._liveCategories.map(c => ({ id: c.slug, label: c.name }))]
    : PRODUCT_CATS;
  el.innerHTML = cats.map(c =>
    `<button class="prod-chip${c.id === _activeProdCat ? ' active' : ''}" onclick="filterProducts('${escapeHTML(c.id)}')">${escapeHTML(c.label)}</button>`
  ).join('');
}

function filterProducts(cat) {
  _activeProdCat = cat;
  buildProductFilters();
  buildProducts();
}

function buildProducts() {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;

  // Live (admin-managed) products take priority once loaded.
  if (_liveProducts) {
    const list = _activeProdCat === 'all'
      ? _liveProducts
      : _liveProducts.filter(p => p.category?.slug === _activeProdCat);
    grid.innerHTML = list.map(p => {
      const out = p.stock === 0;
      return `<div class="prod-card">
        <div class="prod-card-top">
          <span class="prod-dot" style="background:${p.color || '#8b5cf6'}"></span>
          <span class="prod-stock${out ? ' low' : ''}">${escapeHTML(p.stockText || 'In stock')}</span>
        </div>
        <div class="prod-name">${escapeHTML(p.name)}</div>
        <div class="prod-desc">${escapeHTML(p.description || '')}</div>
        <div class="prod-price">${fmtNaira(p.price)}</div>
        <button class="btn ${out ? 'btn-outline' : 'btn-primary'} w-full btn-sm"
          onclick="${out ? "showLandingPage('contact')" : "showPage('register')"}">
          ${out ? 'Contact Sales' : 'Buy Now'}
        </button>
      </div>`;
    }).join('');
    return;
  }

  // Fallback: static catalog.
  const list = _activeProdCat === 'all' ? PRODUCTS : PRODUCTS.filter(p => p.cat === _activeProdCat);
  grid.innerHTML = list.map(p => {
    const out = p.stock === 'Contact us';
    return `<div class="prod-card">
      <div class="prod-card-top">
        <span class="prod-dot" style="background:${p.color}"></span>
        <span class="prod-stock${p.stock === 'Limited' ? ' low' : ''}">${p.stock}</span>
      </div>
      <div class="prod-name">${p.name}</div>
      <div class="prod-desc">${p.desc}</div>
      <div class="prod-price">${fmtNaira(p.usd)}</div>
      <button class="btn ${out ? 'btn-outline' : 'btn-primary'} w-full btn-sm"
        onclick="${out ? "showLandingPage('contact')" : "showPage('register')"}">
        ${out ? 'Contact Sales' : 'Buy Now'}
      </button>
    </div>`;
  }).join('');
}

function buildAppChips() {
  const container = document.getElementById('appChips');
  if (!container) return;
  container.style.display = 'flex';
  container.style.flexWrap = 'wrap';
  container.style.justifyContent = 'center';
  container.style.gap = '10px';
  container.innerHTML = apps.map(a => `
    <div style="display:flex;align-items:center;gap:8px;background:var(--bg-2);border:1px solid var(--border);border-radius:9999px;padding:8px 16px;font-size:.875rem;cursor:pointer;transition:all .2s"
      onmouseover="this.style.borderColor='${a.color}';this.style.boxShadow='0 0 12px ${a.color}44'"
      onmouseout="this.style.borderColor='var(--border)';this.style.boxShadow='none'">
      <span style="width:8px;height:8px;border-radius:50%;background:${a.color};flex-shrink:0"></span>
      ${a.name}
    </div>
  `).join('');
}

// ── FAQ ────────────────────────────────────────────────────
const faqs = [
  { q:'What is a virtual phone number?', a:'A virtual phone number is a real, working phone number assigned to you temporarily. It can receive SMS messages and WhatsApp verifications just like a regular SIM card — no physical SIM, no hardware, no carrier contract required.' },
  { q:'How long does it take to get a number?', a:'Numbers are assigned instantly after purchase — usually within 2–5 seconds. Our number pool is live 24/7 with over 2.4 million active numbers ready to be assigned.' },
  { q:'What happens if I do not receive an OTP?', a:'If no OTP is received within the validity window (20 minutes for WhatsApp, 10 minutes for SMS), you get a full automatic refund to your wallet. No support ticket needed — it is fully automatic.' },
  { q:'What payment methods are accepted?', a:'We accept bank transfer via DrexPay — your only payment method. Transfers are confirmed instantly and your wallet is credited automatically, with zero extra fees. Your wallet balance never expires.' },
  { q:'Is there an API for bulk purchases?', a:'Yes! Our full REST API lets you automate number purchases, poll OTP status in real time, receive instant webhook events, and manage your account programmatically. API docs are in your dashboard under "API Access".' },
  { q:'Are the numbers real and private?', a:'Yes. All numbers come from legitimate telecom providers worldwide. Each number is exclusively assigned to one user per session — never shared. After your session ends, the number enters a cooldown before being reused.' },
  { q:'Which apps and services can I verify?', a:'Our numbers work with WhatsApp, Telegram, Google, Facebook, Instagram, TikTok, Discord, Twitter/X, Tinder, Snapchat, Amazon, Microsoft, Coinbase, Binance, and 500+ other services. Any service that accepts an international number will work.' },
  { q:'Can I reuse the same number?', a:'Each number covers one verification session. For multiple accounts or different services, purchase separate numbers. This ensures your privacy and prevents conflicts between users.' },
  { q:'Does my wallet balance expire?', a:'Never. Your balance carries forward indefinitely. Deposit once, spend it over months or years across any number of purchases. No inactivity fees or balance resets.' },
  { q:'What is the minimum deposit?', a:'Just ₦1,500. This lets you try the service risk-free, with no bonus tiers or hidden minimums for bigger top-ups — every naira you deposit goes straight into your wallet.' },
  { q:'How does the referral program work?', a:'Share your unique referral link. Every time a referral makes a deposit, you earn 10% of the amount as instant wallet credit — automatically, forever, with no cap on earnings.' },
  { q:'Is DonPeeSMS safe and legal?', a:'Yes. Using virtual numbers for privacy, testing, and account creation is legal in most countries. All payments are SSL-encrypted. We do not support fraud and reserve the right to terminate accounts violating our Terms of Service.' },
];

function buildFAQ() {
  const container = document.getElementById('faqList');
  if (!container) return;
  container.innerHTML = faqs.map((f, i) => `
    <div class="faq-item" id="faq-${i}">
      <div class="faq-q" onclick="toggleFAQ(${i})">
        <span>${f.q}</span>
        <div class="faq-icon">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        </div>
      </div>
      <div class="faq-a"><div class="faq-a-inner">${f.a}</div></div>
    </div>
  `).join('');
}

function toggleFAQ(i) {
  const item = document.getElementById('faq-' + i);
  const wasOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-item').forEach(el => el.classList.remove('open'));
  if (!wasOpen) item.classList.add('open');
}

// ── PARTICLES ──────────────────────────────────────────────
function buildParticles() {
  const container = document.getElementById('particles');
  if (!container) return;
  for (let i = 0; i < 20; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.cssText = `
      left:${Math.random() * 100}%;
      --dur:${6 + Math.random() * 8}s;
      --delay:${Math.random() * 6}s;
      --dx:${-40 + Math.random() * 80}px;
      width:${1 + Math.random() * 2}px;
      height:${1 + Math.random() * 2}px;
    `;
    container.appendChild(p);
  }
}

// ── DASHBOARD INIT ─────────────────────────────────────────
async function initDashboard() {
  await _loadAndRenderUser();
  loadDashboardStats();
  loadRecentOrders();
  loadRecentTransactions();
}

async function loadDashboardStats() {
  try {
    const data = await api('GET', '/users/dashboard-stats');
    if (!data) return;
    const s = data.stats || data;
    const els = {
      statBalance:      fmtNaira(s.walletBalance || 0),
      statOrders:       s.totalOrders || 0,
      statCompleted:    s.completedOrders || 0,
      statSpent:        fmtNaira(s.totalSpent || 0)
    };
    Object.entries(els).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    });
  } catch (err) {
    console.error('loadDashboardStats:', err.message);
  }
}

async function loadRecentOrders() {
  try {
    const data = await api('GET', '/numbers/orders?limit=6');
    if (!data) return;
    state.orders = data.orders || [];
    renderOrdersTable();
  } catch (err) {
    console.error('loadRecentOrders:', err.message);
  }
}

async function loadRecentTransactions() {
  try {
    const data = await api('GET', '/wallet/transactions?limit=6');
    if (!data) return;
    state.transactions = data.transactions || [];
    renderTransactions();
  } catch (err) {
    console.error('loadRecentTransactions:', err.message);
  }
}

// ── MODAL CLOSE ON OVERLAY CLICK ──────────────────────────
document.addEventListener('click', e => {
  const modal = document.getElementById('topupModal');
  if (e.target === modal) closeTopupModal();
});

// ── KEYBOARD SHORTCUTS ─────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeTopupModal();
    closeMobileNav();
    closeSidebar();
  }
});

// ── FLOATING OTP MOUSE-REACTIVE EFFECT ─────────────────────
// Each floating OTP number "repels" from cursor when it gets close.
// Numbers also gain a glow and brighter color as the cursor approaches.
function initVerifyStageInteraction() {
  const stage = document.getElementById('verifyStage');
  if (!stage) return;

  const nums = Array.from(stage.querySelectorAll('.float-otp'));
  if (!nums.length) return;

  // Cache per-element data
  const items = nums.map(el => ({
    el,
    depth: parseInt(el.dataset.depth || '40', 10),
    cx: 0, cy: 0       // element center (recomputed on rect refresh)
  }));

  const MAX_DIST = 220;   // px — how close cursor must be to start affecting

  // Smooth pointer position (lerped)
  let mouseX = 0, mouseY = 0;
  let targetX = 0, targetY = 0;
  let hovering = false;
  let rect = stage.getBoundingClientRect();

  const refreshRects = () => {
    rect = stage.getBoundingClientRect();
    items.forEach(it => {
      const r = it.el.getBoundingClientRect();
      it.cx = r.left - rect.left + r.width / 2;
      it.cy = r.top  - rect.top  + r.height / 2;
    });
  };

  // Recompute on resize / scroll
  window.addEventListener('resize', refreshRects);
  window.addEventListener('scroll', refreshRects, { passive: true });
  refreshRects();

  stage.addEventListener('mousemove', (e) => {
    hovering = true;
    targetX = e.clientX - rect.left;
    targetY = e.clientY - rect.top;
  });

  stage.addEventListener('mouseenter', () => {
    refreshRects();
    hovering = true;
  });

  stage.addEventListener('mouseleave', () => {
    hovering = false;
  });

  // Touch support (mobile)
  stage.addEventListener('touchmove', (e) => {
    if (!e.touches.length) return;
    hovering = true;
    targetX = e.touches[0].clientX - rect.left;
    targetY = e.touches[0].clientY - rect.top;
  }, { passive: true });
  stage.addEventListener('touchend', () => { hovering = false; });

  // RAF loop — lerp the pointer + apply repel transforms
  const tick = () => {
    // Lerp mouse position toward target for buttery motion
    mouseX += (targetX - mouseX) * 0.18;
    mouseY += (targetY - mouseY) * 0.18;

    items.forEach(it => {
      let tx = 0, ty = 0, scale = 1;
      let near = false;

      if (hovering) {
        const dx = mouseX - it.cx;
        const dy = mouseY - it.cy;
        const dist = Math.hypot(dx, dy);

        if (dist < MAX_DIST) {
          // 0 → far, 1 → at cursor
          const force = 1 - (dist / MAX_DIST);
          const easedForce = force * force; // ease quad-out

          // Repel direction (away from cursor)
          const dirX = dist > 0 ? dx / dist : 0;
          const dirY = dist > 0 ? dy / dist : 0;

          // Push further for deeper (higher depth) elements
          const push = easedForce * it.depth;
          tx = -dirX * push;
          ty = -dirY * push;
          scale = 1 + easedForce * 0.22;
          near = easedForce > 0.15;
        }
      }

      it.el.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${scale.toFixed(3)})`;
      it.el.classList.toggle('is-near', near);
    });

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ══════════════════════════════════════════
// THEME TOGGLE (Light / Dark)
// ══════════════════════════════════════════
function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('dps-theme', next);
  // Re-draw charts so their background updates
  if (window._charts) window._charts.forEach(c => { try { c.update(); } catch (_e) { /* ignore chart update error */ } });
}
function initTheme() {
  const saved = localStorage.getItem('dps-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}

// ══════════════════════════════════════════
// i18n — MULTI-LANGUAGE SUPPORT
// ══════════════════════════════════════════
const translations = {
  en: {
    'nav.features':'Features','nav.howitworks':'How It Works','nav.services':'Services',
    'nav.pricing':'Pricing','nav.faq':'FAQ','nav.login':'Login','nav.getStarted':'Get Started',
    'hero.badge':'Live — 150+ Countries Available',
    'hero.title1':'Buy Instant','hero.title2':'WhatsApp & SMS','hero.title3':'Virtual Numbers',
    'hero.desc':'Get real international phone numbers for verification, OTP bypass, and privacy. Instant delivery, no ID required.',
    'hero.cta1':'Get a Number Now','hero.cta2':'See How It Works',
    'features.label':'Why DonPeeSMS','features.title':'Built for Speed &','features.title2':'Privacy',
    'pricing.label':'Pricing Plans','pricing.title':'Simple,','pricing.title2':'Transparent Pricing',
    'faq.label':'FAQ','faq.title':'Frequently Asked','faq.title2':'Questions',
  },
  fr: {
    'nav.features':'Fonctionnalités','nav.howitworks':'Comment ça marche','nav.services':'Services',
    'nav.pricing':'Tarifs','nav.faq':'FAQ','nav.login':'Connexion','nav.getStarted':'Commencer',
    'hero.badge':'En direct — 150+ pays disponibles',
    'hero.title1':'Achetez Instantanément','hero.title2':'WhatsApp & SMS','hero.title3':'Numéros Virtuels',
    'hero.desc':'Obtenez de vrais numéros internationaux pour la vérification. Livraison instantanée, sans pièce d\'identité.',
    'hero.cta1':'Obtenir un numéro','hero.cta2':'Voir comment ça marche',
    'features.label':'Pourquoi DonPeeSMS','features.title':'Conçu pour la vitesse &','features.title2':'la confidentialité',
    'pricing.label':'Plans tarifaires','pricing.title':'Simple,','pricing.title2':'Tarification transparente',
    'faq.label':'FAQ','faq.title':'Questions fréquemment','faq.title2':'posées',
  },
  es: {
    'nav.features':'Características','nav.howitworks':'Cómo funciona','nav.services':'Servicios',
    'nav.pricing':'Precios','nav.faq':'FAQ','nav.login':'Iniciar sesión','nav.getStarted':'Comenzar',
    'hero.badge':'En vivo — 150+ países disponibles',
    'hero.title1':'Compra al Instante','hero.title2':'WhatsApp & SMS','hero.title3':'Números Virtuales',
    'hero.desc':'Obtén números internacionales reales para verificación. Entrega instantánea, sin ID requerida.',
    'hero.cta1':'Obtener número ahora','hero.cta2':'Ver cómo funciona',
    'features.label':'Por qué DonPeeSMS','features.title':'Construido para velocidad &','features.title2':'privacidad',
    'pricing.label':'Planes de precios','pricing.title':'Precios simples y','pricing.title2':'transparentes',
    'faq.label':'FAQ','faq.title':'Preguntas frecuentes','faq.title2':'',
  },
  ar: {
    'nav.features':'المميزات','nav.howitworks':'كيف يعمل','nav.services':'الخدمات',
    'nav.pricing':'الأسعار','nav.faq':'الأسئلة الشائعة','nav.login':'تسجيل الدخول','nav.getStarted':'ابدأ الآن',
    'hero.badge':'مباشر — أكثر من 150 دولة متاحة',
    'hero.title1':'اشتر فوراً','hero.title2':'واتساب و SMS','hero.title3':'أرقام افتراضية',
    'hero.desc':'احصل على أرقام هواتف دولية حقيقية للتحقق. تسليم فوري، لا هوية مطلوبة.',
    'hero.cta1':'احصل على رقم الآن','hero.cta2':'كيف يعمل',
    'features.label':'لماذا DonPeeSMS','features.title':'مبني للسرعة و','features.title2':'الخصوصية',
    'pricing.label':'خطط الأسعار','pricing.title':'أسعار بسيطة و','pricing.title2':'شفافة',
    'faq.label':'الأسئلة الشائعة','faq.title':'الأسئلة المتكررة','faq.title2':'',
  },
  pt: {
    'nav.features':'Recursos','nav.howitworks':'Como funciona','nav.services':'Serviços',
    'nav.pricing':'Preços','nav.faq':'FAQ','nav.login':'Entrar','nav.getStarted':'Começar',
    'hero.badge':'Ao vivo — 150+ países disponíveis',
    'hero.title1':'Compre Instantaneamente','hero.title2':'WhatsApp & SMS','hero.title3':'Números Virtuais',
    'hero.desc':'Obtenha números internacionais reais para verificação. Entrega instantânea, sem ID necessário.',
    'hero.cta1':'Obter um número agora','hero.cta2':'Ver como funciona',
    'features.label':'Por que DonPeeSMS','features.title':'Construído para velocidade &','features.title2':'privacidade',
    'pricing.label':'Planos de preços','pricing.title':'Preços simples e','pricing.title2':'transparentes',
    'faq.label':'FAQ','faq.title':'Perguntas frequentes','faq.title2':'',
  }
};

let currentLang = localStorage.getItem('dps-lang') || 'en';

function t(key) {
  return (translations[currentLang] && translations[currentLang][key]) ||
         (translations['en'][key]) || key;
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem('dps-lang', lang);
  document.documentElement.lang = lang;
  // Update all data-i18n elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (t(key) !== key) el.textContent = t(key);
  });
  // Update lang label
  const labels = { en:'EN', fr:'FR', es:'ES', ar:'AR', pt:'PT' };
  const label = document.getElementById('langLabel');
  if (label) label.textContent = labels[lang] || 'EN';
  // Active state
  document.querySelectorAll('.lang-option').forEach(el => {
    el.classList.toggle('active', el.textContent.trim().includes(lang.toUpperCase()) ||
      el.getAttribute('onclick')?.includes(`'${lang}'`));
  });
  // RTL for Arabic
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  // Close dropdown
  document.getElementById('langSwitcher')?.classList.remove('open');
  showToast(`Language changed to ${labels[lang]}`, 'info', 2000);
}

function toggleLangDropdown() {
  document.getElementById('langSwitcher')?.classList.toggle('open');
}

// Close lang dropdown on outside click
document.addEventListener('click', (e) => {
  const ls = document.getElementById('langSwitcher');
  if (ls && !ls.contains(e.target)) ls.classList.remove('open');
});

// ══════════════════════════════════════════
// NOTIFICATIONS DROPDOWN
// ══════════════════════════════════════════
let unreadCount = 3;

function toggleNotifPanel() {
  const wrapper = document.getElementById('notifWrapper');
  if (wrapper) wrapper.classList.toggle('open');
}

function markRead(item) {
  if (item.classList.contains('unread')) {
    item.classList.remove('unread');
    const dot = item.querySelector('.notif-unread-dot');
    if (dot) dot.remove();
    unreadCount = Math.max(0, unreadCount - 1);
    updateNotifBadge();
  }
}

function markAllRead() {
  document.querySelectorAll('.notif-item.unread').forEach(item => {
    item.classList.remove('unread');
    const dot = item.querySelector('.notif-unread-dot');
    if (dot) dot.remove();
  });
  unreadCount = 0;
  updateNotifBadge();
  showToast('All notifications marked as read', 'success', 2000);
}

function updateNotifBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  if (unreadCount === 0) {
    badge.style.display = 'none';
  } else {
    badge.style.display = 'flex';
    badge.textContent = unreadCount;
  }
}

// Close notifications on outside click
document.addEventListener('click', (e) => {
  const nw = document.getElementById('notifWrapper');
  if (nw && !nw.contains(e.target)) nw.classList.remove('open');
});

// ══════════════════════════════════════════
// LIVE CHAT
// ══════════════════════════════════════════
// ══════════════════════════════════════════
// LIVE CHAT PANEL — smart bot + WhatsApp CTA
// ══════════════════════════════════════════
const CHAT_WA_URL = 'https://wa.me/2347084869630?text=Hi%20DonPeeSMS%2C%20I%20need%20support';
let _chatOpen      = false;
let _chatGreeted   = false;

// ── Knowledge base ──────────────────────────────────────────
const CHAT_KB = [
  {
    keys: ['price','pricing','cost','how much','cheap','expensive','fee','rate','plan'],
    reply: `Our numbers start from as low as <strong>₦160 per use</strong>! 🎉<br><br>
      • <strong>Basic SMS</strong> – from ₦160<br>
      • <strong>WhatsApp numbers</strong> – from ₦400<br>
      • <strong>Premium countries (US/UK)</strong> – from ₦800<br><br>
      No subscriptions — pay only for what you use. Top up your wallet and go! 💳`,
    wa: 'Hi DonPeeSMS, I want to know more about pricing'
  },
  {
    keys: ['country','countries','nation','available','which country','usa','uk','nigeria','india','germany','france','canada'],
    reply: `We cover <strong>150+ countries</strong> including 🇺🇸 USA, 🇬🇧 UK, 🇩🇪 Germany, 🇮🇳 India, 🇧🇷 Brazil, 🇳🇬 Nigeria, 🇨🇦 Canada, 🇫🇷 France and many more.<br><br>
      Simply select your target country in the dashboard and pick a number instantly. New countries are added every week! 🌍`,
    wa: 'Hi DonPeeSMS, I want to check available countries'
  },
  {
    keys: ['how','work','start','begin','step','process','use','get number','buy number'],
    reply: `Getting your number takes <strong>under 60 seconds</strong>! ⚡<br><br>
      <strong>1.</strong> Create a free account<br>
      <strong>2.</strong> Top up your wallet (from ₦1,500)<br>
      <strong>3.</strong> Pick a country + service<br>
      <strong>4.</strong> Receive your OTP instantly<br><br>
      No ID, no KYC, no waiting — just instant delivery! 🚀`,
    wa: 'Hi DonPeeSMS, I want to understand how it works'
  },
  {
    keys: ['pay','payment','crypto','bitcoin','btc','card','paypal','usdt','ethereum','deposit','fund','wallet','top up','drexpay','bank transfer'],
    reply: `Topping up is simple: 💳<br><br>
      • <strong>Bank Transfer via DrexPay</strong> — our only payment method<br>
      • <strong>Instant confirmation</strong> — your wallet is credited the moment the transfer clears<br>
      • <strong>No card, crypto, or third-party wallet needed</strong><br><br>
      Minimum top-up is just ₦1,500! 🔒`,
    wa: 'Hi DonPeeSMS, I have a payment question'
  },
  {
    keys: ['refund','money back','return','cancel','didn\'t work','not work','expire','expired','no sms received'],
    reply: `We have a <strong>100% Auto-Refund Policy</strong>! 🛡️<br><br>
      If you don't receive an SMS within the active window, your balance is <strong>automatically refunded</strong> — no questions asked.<br><br>
      Manual refund requests? Our team processes them within 24 hours. ✅`,
    wa: 'Hi DonPeeSMS, I want to request a refund'
  },
  {
    keys: ['not receiving','no message','no otp','sms not coming','not getting','problem','issue','broken','error','fail','stuck'],
    reply: `Sorry to hear that! 😟 Let's fix this fast:<br><br>
      <strong>Quick checks:</strong><br>
      1. Make sure the number is still <strong>active</strong> (not expired)<br>
      2. Try requesting the OTP again on the service<br>
      3. Some services take up to <strong>2 minutes</strong> to deliver<br>
      4. Try a <strong>different number</strong> from the same country<br><br>
      Still stuck? Chat our team on WhatsApp for live help 👇`,
    wa: 'Hi DonPeeSMS, I am not receiving SMS on my number'
  },
  {
    keys: ['account','login','register','password','sign in','sign up','email','forgot','reset','2fa','verify','verification'],
    reply: `Account help — we've got you! 🔐<br><br>
      • <strong>Forgot password?</strong> Use the "Forgot Password" link on the login page<br>
      • <strong>2FA issues?</strong> Contact support with your registered email<br>
      • <strong>Account locked?</strong> Email us at <strong>support@donpeesms.com</strong><br><br>
      For urgent account issues, WhatsApp is the fastest option 👇`,
    wa: 'Hi DonPeeSMS, I have an account issue'
  },
  {
    keys: ['whatsapp','wa','wapp','whats app','whatsapp number','whatsapp verification'],
    reply: `Yes, we support <strong>WhatsApp verification</strong> numbers! 📱✅<br><br>
      Our WhatsApp numbers work for:<br>
      • New WhatsApp account registration<br>
      • Re-verifying existing accounts<br>
      • Business WhatsApp setup<br><br>
      Pick a number, enter it in WhatsApp, and the OTP arrives in seconds. Works with 150+ countries! 🌍`,
    wa: 'Hi DonPeeSMS, I want a WhatsApp verification number'
  },
  {
    keys: ['safe','secure','anonymous','privacy','id','kyc','identity','data','trust','legit','real'],
    reply: `Your privacy is our priority! 🔒<br><br>
      • <strong>No KYC</strong> — zero ID verification required<br>
      • <strong>Anonymous numbers</strong> — never linked to your identity<br>
      • <strong>Encrypted</strong> — all transactions secured with SSL<br>
      • <strong>120,000+ users</strong> trust us worldwide<br><br>
      We never share or sell your data. Period. ✅`,
    wa: 'Hi DonPeeSMS, I want to know about security and privacy'
  },
  {
    keys: ['human','agent','person','staff','talk','speak','call','live','real person','support team'],
    reply: `Of course! Our team is always ready to help. 🧑‍💼<br><br>
      The fastest way to reach a human agent is via <strong>WhatsApp</strong> — we typically respond in under 3 minutes.<br><br>
      You can also reach us at:<br>
      📧 support@donpeesms.com<br>
      📱 WhatsApp: +234 708 486 9630<br><br>
      Tap the button below to connect now 👇`,
    wa: 'Hi DonPeeSMS, I would like to speak with a human agent'
  }
];

function _chatGetReply(text) {
  const lower = text.toLowerCase();
  for (const item of CHAT_KB) {
    if (item.keys.some(k => lower.includes(k))) return item;
  }
  return null;
}

// ── Core toggle ─────────────────────────────────────────────
function toggleChatPanel() {
  _chatOpen = !_chatOpen;
  const panel = document.getElementById('chatPanel');
  const fab   = document.getElementById('chatFab');
  const badge = document.getElementById('chatFabBadge');
  const icoO  = document.getElementById('chatIconOpen');
  const icoC  = document.getElementById('chatIconClose');
  if (!panel) return;

  panel.classList.toggle('is-open', _chatOpen);
  panel.setAttribute('aria-hidden', String(!_chatOpen));
  fab.classList.toggle('is-open', _chatOpen);
  if (icoO) icoO.style.display = _chatOpen ? 'none' : '';
  if (icoC) icoC.style.display = _chatOpen ? ''     : 'none';
  if (badge) badge.style.display = 'none';

  if (_chatOpen && !_chatGreeted) {
    _chatGreeted = true;
    _chatDeliverAgent(
      `Hey there! 👋 Welcome to <strong>DonPeeSMS</strong>!<br><br>
      I can help you with pricing, how it works, payments, refunds, and more.<br>
      Or tap <strong>Continue on WhatsApp</strong> below to chat with a real human instantly. 🚀`,
      800
    );
  }

  if (_chatOpen) {
    setTimeout(() => {
      const inp = document.getElementById('chatInput');
      if (inp) inp.focus();
    }, 280);
  }
}

// ── Quick-reply chips ────────────────────────────────────────
function chatQuickReply(topic) {
  const labels = {
    pricing:    '💰 What are your prices?',
    countries:  '🌍 Which countries do you support?',
    howitworks: '📱 How does it work?',
    payment:    '💳 What payment methods do you accept?',
    refund:     '🔄 What is your refund policy?',
    human:      '🧑 I want to talk to a human agent'
  };
  const text = labels[topic] || topic;
  const input = document.getElementById('chatInput');
  if (input) { input.value = text; }
  sendChatMessage();

  // Hide chips after first use so they don't clutter
  const chips = document.getElementById('chatChips');
  if (chips) chips.style.display = 'none';
}

// ── Send message ─────────────────────────────────────────────
function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const msgs  = document.getElementById('chatMessages');
  if (!input || !msgs) return;
  const text = input.value.trim();
  if (!text) return;

  // User bubble
  const userDiv = document.createElement('div');
  userDiv.className = 'chat-msg chat-msg--user';
  userDiv.innerHTML = `<div class="chat-bubble">${escapeHTML(text)}</div>
    <div class="chat-time">You</div>`;
  msgs.appendChild(userDiv);

  input.value = '';
  autoResizeChatInput(input);
  msgs.scrollTop = msgs.scrollHeight;

  // Hide chips
  const chips = document.getElementById('chatChips');
  if (chips) chips.style.display = 'none';

  // Typing indicator
  const typing = document.createElement('div');
  typing.className = 'chat-msg chat-msg--agent chat-typing';
  typing.innerHTML = `<div class="chat-bubble">
    <span class="chat-typing-dot"></span>
    <span class="chat-typing-dot"></span>
    <span class="chat-typing-dot"></span>
  </div>`;
  msgs.appendChild(typing);
  msgs.scrollTop = msgs.scrollHeight;

  setTimeout(() => {
    typing.remove();

    const match = _chatGetReply(text);
    let replyHTML, waParam;

    if (match) {
      replyHTML = match.reply;
      waParam   = encodeURIComponent(match.wa);
    } else {
      replyHTML = `Great question! 🤔 Our support team will give you the best answer.<br><br>
        Tap <strong>Continue on WhatsApp</strong> below and a real agent will reply in under 3 minutes. ⚡`;
      waParam = encodeURIComponent('Hi DonPeeSMS, I have a question: ' + text);
    }

    // Update WA bar link with context
    const waBtn = document.querySelector('.chat-wa-btn');
    if (waBtn) waBtn.href = `https://wa.me/2347084869630?text=${waParam}`;

    _chatDeliverAgent(replyHTML, 0);
  }, 1400);
}

function _chatDeliverAgent(html, delay = 0) {
  const msgs = document.getElementById('chatMessages');
  if (!msgs) return;
  const fn = () => {
    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg--agent';
    div.innerHTML = `<div class="chat-bubble">${html}</div>
      <div class="chat-time">DonPeeSMS Bot</div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  };
  if (delay) setTimeout(fn, delay); else fn();
}

// ── Helpers ──────────────────────────────────────────────────
function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
}
function autoResizeChatInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}
function escapeHTML(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('chatInput');
  if (inp) inp.addEventListener('input', () => autoResizeChatInput(inp));
});

// Legacy alias
function openLiveChat() { toggleChatPanel(); }

// ══════════════════════════════════════════
// PWA — SERVICE WORKER + INSTALL PROMPT
// ══════════════════════════════════════════
let _pwaPrompt = null;

function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      console.log('[PWA] SW registered:', reg.scope);
    }).catch(err => console.log('[PWA] SW error:', err));
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _pwaPrompt = e;
    const banner = document.getElementById('pwaBanner');
    if (banner) banner.classList.add('visible');
  });
  const installBtn = document.getElementById('pwaInstallBtn');
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!_pwaPrompt) return;
      _pwaPrompt.prompt();
      const { outcome } = await _pwaPrompt.userChoice;
      if (outcome === 'accepted') {
        document.getElementById('pwaBanner').classList.remove('visible');
        showToast('DonPeeSMS installed!', 'success');
      }
      _pwaPrompt = null;
    });
  }
  window.addEventListener('appinstalled', () => {
    document.getElementById('pwaBanner')?.classList.remove('visible');
    showToast('App installed successfully!', 'success');
  });
}

// ══════════════════════════════════════════
// CHART.JS DASHBOARD CHARTS
// ══════════════════════════════════════════
window._charts = [];

function getChartColors() {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  return {
    grid:   dark ? 'rgba(30,27,75,.5)' : 'rgba(139,92,246,.1)',
    tick:   dark ? '#64748B' : '#7B78A8',
    bg:     dark ? '#0D0D1F'  : '#ffffff',
    purple: 'rgba(139,92,246,',
    green:  'rgba(16,185,129,',
    amber:  'rgba(245,158,11,',
    blue:   'rgba(59,130,246,',
  };
}

function destroyChart(id) {
  const idx = window._charts.findIndex(c => c.canvas?.id === id);
  if (idx !== -1) { window._charts[idx].destroy(); window._charts.splice(idx, 1); }
}

function initDashboardCharts() {
  const c = getChartColors();
  Chart.defaults.font.family = "'Exo 2', sans-serif";
  Chart.defaults.color = c.tick;

  // 1. Revenue line chart (30 days)
  destroyChart('chartRevenue');
  const revEl = document.getElementById('chartRevenue');
  if (revEl) {
    const labels = Array.from({length:30},(_,i)=>{
      const d=new Date(); d.setDate(d.getDate()-29+i);
      return d.toLocaleDateString('en',{month:'short',day:'numeric'});
    });
    const data = labels.map(()=>0);
    const ch = new Chart(revEl, {
      type:'line',
      data:{
        labels,
        datasets:[{
          label:'Revenue (₦)',
          data,
          borderColor:'rgba(139,92,246,1)',
          backgroundColor:'rgba(139,92,246,.12)',
          borderWidth:2,
          fill:true,
          tension:.4,
          pointRadius:0,
          pointHoverRadius:5,
          pointHoverBackgroundColor:'rgba(139,92,246,1)'
        }]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{mode:'index',intersect:false} },
        scales:{
          x:{ grid:{color:c.grid}, ticks:{color:c.tick,maxTicksLimit:6} },
          y:{ grid:{color:c.grid}, ticks:{color:c.tick,callback:v=>'₦'+Number(v).toLocaleString()} }
        }
      }
    });
    window._charts.push(ch);
  }

  // 2. OTP Success doughnut
  destroyChart('chartSuccess');
  const sucEl = document.getElementById('chartSuccess');
  if (sucEl) {
    const ch = new Chart(sucEl, {
      type:'doughnut',
      data:{
        labels:['Received','Expired','Refunded'],
        datasets:[{
          data:[0, 0, 0],
          backgroundColor:['rgba(16,185,129,.85)','rgba(245,158,11,.85)','rgba(239,68,68,.85)'],
          borderWidth:0, hoverOffset:4
        }]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        cutout:'72%',
        plugins:{
          legend:{position:'bottom', labels:{color:c.tick,boxWidth:10,padding:14}},
          tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${ctx.parsed}%`}}
        }
      }
    });
    window._charts.push(ch);
  }

  // 3. Service bar (WA vs SMS)
  destroyChart('chartService');
  const svcEl = document.getElementById('chartService');
  if (svcEl) {
    const ch = new Chart(svcEl, {
      type:'bar',
      data:{
        labels:['Jan','Feb','Mar','Apr','May','Jun'],
        datasets:[
          { label:'WhatsApp', data:[0,0,0,0,0,0], backgroundColor:'rgba(37,211,102,.75)', borderRadius:4 },
          { label:'SMS',      data:[0,0,0,0,0,0], backgroundColor:'rgba(139,92,246,.75)', borderRadius:4 }
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ labels:{color:c.tick,boxWidth:10} } },
        scales:{
          x:{ grid:{display:false}, ticks:{color:c.tick} },
          y:{ grid:{color:c.grid}, ticks:{color:c.tick} }
        }
      }
    });
    window._charts.push(ch);
  }

  // 4. Country bar
  destroyChart('chartCountry');
  const cntEl = document.getElementById('chartCountry');
  if (cntEl) {
    const ch = new Chart(cntEl, {
      type:'bar',
      data:{
        labels:['US','IN','NG','GB','BR','PK','DE'],
        datasets:[{
          label:'Orders',
          data:[0,0,0,0,0,0,0],
          backgroundColor:'rgba(59,130,246,.75)',
          borderRadius:4
        }]
      },
      options:{
        indexAxis:'y',
        responsive:true, maintainAspectRatio:false,
        plugins:{legend:{display:false}},
        scales:{
          x:{ grid:{color:c.grid}, ticks:{color:c.tick} },
          y:{ grid:{display:false}, ticks:{color:c.tick} }
        }
      }
    });
    window._charts.push(ch);
  }

  // 5. Daily orders sparkline
  destroyChart('chartDaily');
  const dayEl = document.getElementById('chartDaily');
  if (dayEl) {
    const ch = new Chart(dayEl, {
      type:'line',
      data:{
        labels:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
        datasets:[{
          label:'Orders',
          data:[0,0,0,0,0,0,0],
          borderColor:'rgba(245,158,11,1)',
          backgroundColor:'rgba(245,158,11,.12)',
          borderWidth:2, fill:true, tension:.4, pointRadius:3,
          pointBackgroundColor:'rgba(245,158,11,1)'
        }]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{legend:{display:false}},
        scales:{
          x:{ grid:{display:false}, ticks:{color:c.tick} },
          y:{ grid:{color:c.grid}, ticks:{color:c.tick} }
        }
      }
    });
    window._charts.push(ch);
  }
}

// Admin charts
function initAdminCharts() {
  const c = getChartColors();
  Chart.defaults.color = c.tick;

  // Admin revenue chart
  destroyChart('adminChartRevenue');
  const el1 = document.getElementById('adminChartRevenue');
  if (el1) {
    const labels = Array.from({length:30},(_,i)=>{
      const d=new Date(); d.setDate(d.getDate()-29+i);
      return d.toLocaleDateString('en',{month:'short',day:'numeric'});
    });
    const ch = new Chart(el1, {
      type:'line',
      data:{
        labels,
        datasets:[
          { label:'Revenue', data:labels.map(()=>Math.floor(Math.random()*800+400)),
            borderColor:'rgba(139,92,246,1)', backgroundColor:'rgba(139,92,246,.1)',
            borderWidth:2, fill:true, tension:.4, pointRadius:0 },
          { label:'Profit',  data:labels.map(()=>Math.floor(Math.random()*300+150)),
            borderColor:'rgba(16,185,129,1)', backgroundColor:'rgba(16,185,129,.07)',
            borderWidth:2, fill:true, tension:.4, pointRadius:0 }
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{labels:{color:c.tick,boxWidth:10}}, tooltip:{mode:'index',intersect:false} },
        scales:{
          x:{ grid:{color:c.grid}, ticks:{color:c.tick,maxTicksLimit:8} },
          y:{ grid:{color:c.grid}, ticks:{color:c.tick,callback:v=>'₦'+Number(v).toLocaleString()} }
        }
      }
    });
    window._charts.push(ch);
  }

  // Admin user registrations
  destroyChart('adminChartUsers');
  const el2 = document.getElementById('adminChartUsers');
  if (el2) {
    const ch = new Chart(el2, {
      type:'bar',
      data:{
        labels:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
        datasets:[{
          label:'New Users',
          data:[48,62,55,78,91,84,60],
          backgroundColor:'rgba(139,92,246,.75)', borderRadius:6
        }]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{legend:{display:false}},
        scales:{
          x:{ grid:{display:false}, ticks:{color:c.tick} },
          y:{ grid:{color:c.grid}, ticks:{color:c.tick} }
        }
      }
    });
    window._charts.push(ch);
  }

  // Admin monthly stacked bar
  destroyChart('adminChartMonthly');
  const el3 = document.getElementById('adminChartMonthly');
  if (el3) {
    const ch = new Chart(el3, {
      type:'bar',
      data:{
        labels:['Dec','Jan','Feb','Mar','Apr','May'],
        datasets:[
          { label:'WhatsApp', data:[8200,9400,11200,13100,15800,18200],
            backgroundColor:'rgba(37,211,102,.8)', borderRadius:4 },
          { label:'SMS',      data:[3100,4200,5800,6400,7200,8400],
            backgroundColor:'rgba(139,92,246,.8)', borderRadius:4 }
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{labels:{color:c.tick,boxWidth:10}}, tooltip:{mode:'index',intersect:false} },
        scales:{
          x:{ grid:{display:false}, ticks:{color:c.tick}, stacked:true },
          y:{ grid:{color:c.grid}, ticks:{color:c.tick,callback:v=>'₦'+Number(v).toLocaleString()}, stacked:true }
        }
      }
    });
    window._charts.push(ch);
  }
}

// ══════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════
const adminSections = ['overview','products','categories','apiproviders','users','pricing','providers','orders','revenue','settings'];
const adminTitles = {
  'overview':'Admin Overview','products':'All Products','categories':'Categories','apiproviders':'API Providers','users':'User Management','pricing':'Pricing Management',
  'providers':'Provider Management','orders':'All Orders','revenue':'Revenue Analytics','settings':'Platform Settings'
};

function adminNav(section) {
  adminSections.forEach(s => {
    const el = document.getElementById('admin-' + s);
    if (el) el.classList.toggle('active', s === section);
  });
  document.querySelectorAll('.admin-nav-link').forEach(el => {
    el.classList.toggle('active', el.getAttribute('onclick')?.includes(`'${section}'`));
  });
  const title = document.getElementById('adminTitle');
  if (title) title.textContent = adminTitles[section] || 'Admin';

  if (section === 'overview')   { setTimeout(initAdminCharts, 50); }
  if (section === 'products')   loadAdminProducts();
  if (section === 'categories') loadAdminCategories();
  if (section === 'apiproviders') loadApiProviders();
  if (section === 'users')      buildAdminUsers();
  if (section === 'pricing')    buildAdminPricing();
  if (section === 'orders')     buildAdminOrders();
  if (section === 'revenue')    setTimeout(()=>{ destroyChart('adminChartMonthly'); initAdminCharts(); }, 50);
}

// ═════════════════════════════════════════════
// ADMIN — PRODUCT MANAGEMENT (CRUD)
// ═════════════════════════════════════════════
let _adminCategories = [];
let _adminProviders  = [];

async function loadAdminProducts() {
  const tbody = document.getElementById('adminProductsBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--txt-4);padding:26px">Loading…</td></tr>`;
  try {
    // allSettled, not all: categories/providers only populate the
    // Add/Edit dropdowns. If one of them fails there is no reason to
    // blank the product table too — the products request is the only
    // one whose failure should surface as an error.
    const [prodRes, catRes, provRes] = await Promise.allSettled([
      api('GET', '/admin/products'),
      api('GET', '/admin/categories'),
      api('GET', '/admin/providers')
    ]);
    if (prodRes.status === 'rejected') throw prodRes.reason;

    _adminCategories = catRes.status === 'fulfilled' ? (catRes.value?.categories || []) : [];
    _adminProviders  = provRes.status === 'fulfilled' ? (provRes.value?.providers  || []) : [];
    renderAdminProducts(prodRes.value?.products || []);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--error);padding:26px">${escapeHTML(err.message || 'Failed to load products')}</td></tr>`;
  }
}

function renderAdminProducts(products) {
  const tbody = document.getElementById('adminProductsBody');
  if (!tbody) return;
  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--txt-4);padding:26px">No products yet. Click "Add Product" to create one.</td></tr>`;
    return;
  }
  tbody.innerHTML = products.map(p => {
    const stockText = p.stock === -1 ? 'Unlimited' : p.stockLabel || (p.stock === 0 ? 'Out of stock' : p.stock + ' units');
    return `<tr>
      <td><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${p.color || 'var(--p-500)'}"></span></td>
      <td>
        <div style="font-weight:600">${escapeHTML(p.name)}${p.featured ? ' <span class="badge badge-purple" style="font-size:.65rem">Featured</span>' : ''}</div>
        <div style="font-size:.75rem;color:var(--txt-4)">${escapeHTML(p.description || '')}</div>
      </td>
      <td style="color:var(--txt-3)">${p.category ? escapeHTML(p.category.name) : '—'}</td>
      <td>${fmtNaira(p.price)}</td>
      <td style="color:var(--txt-3);font-size:.85rem">${stockText}</td>
      <td style="color:var(--txt-4);font-size:.82rem">${p.apiProvider === 'manual' ? 'Manual' : escapeHTML(p.apiProvider)}</td>
      <td>
        <div class="provider-toggle${p.enabled ? ' on' : ''}" style="position:static" onclick="toggleProductEnabled('${p.id}')"></div>
      </td>
      <td style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" onclick="openProductModal('${p.id}')">Edit</button>
        <button class="btn btn-outline btn-sm" style="color:var(--error)" onclick="deleteProduct('${p.id}')">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

function _fillProductSelects() {
  const catSel = document.getElementById('prodCategory');
  if (catSel) {
    catSel.innerHTML = '<option value="">— None —</option>' +
      _adminCategories.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');
  }
  const provSel = document.getElementById('prodProvider');
  if (provSel) {
    provSel.innerHTML = _adminProviders.map(p =>
      `<option value="${p.id}">${escapeHTML(p.name)}${p.configured ? '' : ' (not configured)'}</option>`
    ).join('') || '<option value="manual">Manual fulfilment</option>';
  }
}

async function openProductModal(id) {
  _fillProductSelects();
  const modal = document.getElementById('productModal');
  const title = document.getElementById('productModalTitle');
  document.getElementById('prodId').value = '';
  document.getElementById('prodName').value = '';
  document.getElementById('prodDesc').value = '';
  document.getElementById('prodPrice').value = '';
  document.getElementById('prodCategory').value = '';
  document.getElementById('prodStock').value = '-1';
  document.getElementById('prodStockLabel').value = '';
  document.getElementById('prodProvider').value = 'manual';
  document.getElementById('prodColor').value = '#8b5cf6';
  document.getElementById('prodImage').value = '';
  document.getElementById('prodEnabled').checked = true;
  document.getElementById('prodFeatured').checked = false;
  updateProdPriceNaira();

  if (id) {
    title.textContent = 'Edit Product';
    try {
      const res = await api('GET', '/admin/products');
      const p = (res?.products || []).find(x => x.id === id);
      if (p) {
        document.getElementById('prodId').value = p.id;
        document.getElementById('prodName').value = p.name;
        document.getElementById('prodDesc').value = p.description || '';
        document.getElementById('prodPrice').value = p.price;
        document.getElementById('prodCategory').value = p.categoryId || '';
        document.getElementById('prodStock').value = p.stock;
        document.getElementById('prodStockLabel').value = p.stockLabel || '';
        document.getElementById('prodProvider').value = p.apiProvider || 'manual';
        document.getElementById('prodColor').value = p.color || '#8b5cf6';
        document.getElementById('prodImage').value = p.imageUrl || '';
        document.getElementById('prodEnabled').checked = !!p.enabled;
        document.getElementById('prodFeatured').checked = !!p.featured;
        updateProdPriceNaira();
      }
    } catch (err) {
      showToast(err.message || 'Failed to load product', 'error');
    }
  } else {
    title.textContent = 'Add Product';
  }
  modal.classList.add('open');
}

function closeProductModal() {
  document.getElementById('productModal').classList.remove('open');
}

function updateProdPriceNaira() {
  const ngn = parseFloat(document.getElementById('prodPrice')?.value || 0);
  const el = document.getElementById('prodPriceNaira');
  if (el) el.textContent = fmtNaira(ngn);
}

async function saveProduct() {
  const id = document.getElementById('prodId').value;
  const name = document.getElementById('prodName').value.trim();
  const price = parseFloat(document.getElementById('prodPrice').value);
  if (!name) return showToast('Product name is required', 'warning');
  if (isNaN(price) || price < 0) return showToast('Enter a valid price', 'warning');

  const payload = {
    name,
    description: document.getElementById('prodDesc').value.trim(),
    price,
    categoryId: document.getElementById('prodCategory').value || null,
    stock: parseInt(document.getElementById('prodStock').value || '-1', 10),
    stockLabel: document.getElementById('prodStockLabel').value.trim(),
    apiProvider: document.getElementById('prodProvider').value,
    color: document.getElementById('prodColor').value,
    imageUrl: document.getElementById('prodImage').value.trim(),
    enabled: document.getElementById('prodEnabled').checked,
    featured: document.getElementById('prodFeatured').checked
  };

  const btn = document.getElementById('prodSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    if (id) await api('PATCH', '/admin/products/' + id, payload);
    else    await api('POST', '/admin/products', payload);
    showToast(id ? 'Product updated' : 'Product created', 'success');
    closeProductModal();
    loadAdminProducts();
  } catch (err) {
    showToast(err.message || 'Failed to save product', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Product';
  }
}

async function toggleProductEnabled(id) {
  try {
    await api('PATCH', '/admin/products/' + id + '/toggle');
    loadAdminProducts();
  } catch (err) {
    showToast(err.message || 'Failed to toggle product', 'error');
  }
}

async function deleteProduct(id) {
  if (!confirm('Delete this product? This cannot be undone.')) return;
  try {
    await api('DELETE', '/admin/products/' + id);
    showToast('Product deleted', 'success');
    loadAdminProducts();
  } catch (err) {
    showToast(err.message || 'Failed to delete product', 'error');
  }
}

// ── CATEGORIES ──────────────────────────────────────────────
async function loadAdminCategories() {
  const tbody = document.getElementById('adminCategoriesBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--txt-4);padding:26px">Loading…</td></tr>`;
  try {
    const res = await api('GET', '/admin/categories');
    _adminCategories = res?.categories || [];
    renderAdminCategories(_adminCategories);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--error);padding:26px">${escapeHTML(err.message || 'Failed to load categories')}</td></tr>`;
  }
}

function renderAdminCategories(cats) {
  const tbody = document.getElementById('adminCategoriesBody');
  if (!tbody) return;
  if (!cats.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--txt-4);padding:26px">No categories yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = cats.map(c => `<tr>
    <td style="font-size:1.1rem">${c.icon || '📦'}</td>
    <td style="font-weight:600">${escapeHTML(c.name)}</td>
    <td style="color:var(--txt-4);font-size:.82rem">${escapeHTML(c.slug)}</td>
    <td>${c.productCount ?? 0}</td>
    <td><div class="provider-toggle${c.active ? ' on' : ''}" style="position:static" onclick="toggleCategoryActive('${c.id}', ${c.active})"></div></td>
    <td style="display:flex;gap:6px">
      <button class="btn btn-outline btn-sm" onclick="openCategoryModal('${c.id}')">Edit</button>
      <button class="btn btn-outline btn-sm" style="color:var(--error)" onclick="deleteCategory('${c.id}')">Delete</button>
    </td>
  </tr>`).join('');
}

function openCategoryModal(id) {
  const modal = document.getElementById('categoryModal');
  const title = document.getElementById('categoryModalTitle');
  document.getElementById('catId').value = '';
  document.getElementById('catName').value = '';
  document.getElementById('catIcon').value = '';
  if (id) {
    const c = _adminCategories.find(x => x.id === id);
    title.textContent = 'Edit Category';
    if (c) {
      document.getElementById('catId').value = c.id;
      document.getElementById('catName').value = c.name;
      document.getElementById('catIcon').value = c.icon || '';
    }
  } else {
    title.textContent = 'Add Category';
  }
  modal.classList.add('open');
}

function closeCategoryModal() {
  document.getElementById('categoryModal').classList.remove('open');
}

async function saveCategory() {
  const id = document.getElementById('catId').value;
  const name = document.getElementById('catName').value.trim();
  if (!name) return showToast('Category name is required', 'warning');
  const payload = { name, icon: document.getElementById('catIcon').value.trim() };

  const btn = document.getElementById('catSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    if (id) await api('PATCH', '/admin/categories/' + id, payload);
    else    await api('POST', '/admin/categories', payload);
    showToast(id ? 'Category updated' : 'Category created', 'success');
    closeCategoryModal();
    loadAdminCategories();
  } catch (err) {
    showToast(err.message || 'Failed to save category', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Category';
  }
}

async function toggleCategoryActive(id, current) {
  try {
    await api('PATCH', '/admin/categories/' + id, { active: !current });
    loadAdminCategories();
  } catch (err) {
    showToast(err.message || 'Failed to toggle category', 'error');
  }
}

async function deleteCategory(id) {
  if (!confirm('Delete this category? Products in it will become uncategorized.')) return;
  try {
    await api('DELETE', '/admin/categories/' + id);
    showToast('Category deleted', 'success');
    loadAdminCategories();
  } catch (err) {
    showToast(err.message || 'Failed to delete category', 'error');
  }
}

// ═════════════════════════════════════════════
// ADMIN — API PROVIDERS (CRUD)
// ═════════════════════════════════════════════
let _apiProvidersCache = [];

async function loadApiProviders() {
  const tbody = document.getElementById('adminApiProvidersBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--txt-4);padding:26px">Loading…</td></tr>`;
  try {
    const res = await api('GET', '/admin/api-providers');
    _apiProvidersCache = res?.providers || [];
    renderApiProviders(_apiProvidersCache);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--error);padding:26px">${escapeHTML(err.message || 'Failed to load providers')}</td></tr>`;
  }
}

function renderApiProviders(providers) {
  const tbody = document.getElementById('adminApiProvidersBody');
  if (!tbody) return;
  if (!providers.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--txt-4);padding:26px">No custom providers yet. Click "Add Provider" to connect one.</td></tr>`;
    return;
  }
  tbody.innerHTML = providers.map(p => `<tr>
    <td style="font-weight:600">${escapeHTML(p.name)}</td>
    <td style="color:var(--txt-4);font-size:.82rem">${escapeHTML(p.slug)}</td>
    <td style="color:var(--txt-3);font-size:.82rem;max-width:220px;overflow:hidden;text-overflow:ellipsis">${escapeHTML(p.baseUrl)}</td>
    <td style="color:var(--txt-4);font-size:.82rem">${escapeHTML(p.authHeader)}</td>
    <td style="font-size:.82rem">${p.hasKey ? '<span style="color:var(--success)">' + escapeHTML(p.keyPreview || '••••••••') + '</span>' : '<span style="color:var(--warning)">Not set</span>'}</td>
    <td><div class="provider-toggle${p.enabled ? ' on' : ''}" style="position:static" onclick="toggleApiProvider('${p.id}')"></div></td>
    <td style="display:flex;gap:6px">
      <button class="btn btn-outline btn-sm" onclick="openApiProviderModal('${p.id}')">Edit</button>
      <button class="btn btn-outline btn-sm" style="color:var(--error)" onclick="deleteApiProvider('${p.id}')">Delete</button>
    </td>
  </tr>`).join('');
}

function openApiProviderModal(id) {
  const modal = document.getElementById('apiProviderModal');
  const title = document.getElementById('apiProviderModalTitle');
  const hint  = document.getElementById('apKeyHint');
  document.getElementById('apId').value = '';
  document.getElementById('apNameInput').value = '';
  document.getElementById('apBaseUrl').value = '';
  document.getElementById('apAuthHeader').value = 'x-api-key';
  document.getElementById('apApiKey').value = '';
  document.getElementById('apNotes').value = '';
  document.getElementById('apEnabled').checked = true;

  if (id) {
    const p = _apiProvidersCache.find(x => x.id === id);
    title.textContent = 'Edit API Provider';
    if (hint) hint.textContent = 'Leave blank to keep the existing key. Entering a new value replaces it.';
    if (p) {
      document.getElementById('apId').value = p.id;
      document.getElementById('apNameInput').value = p.name;
      document.getElementById('apBaseUrl').value = p.baseUrl;
      document.getElementById('apAuthHeader').value = p.authHeader || 'x-api-key';
      document.getElementById('apNotes').value = p.notes || '';
      document.getElementById('apEnabled').checked = !!p.enabled;
    }
  } else {
    title.textContent = 'Add API Provider';
    if (hint) hint.textContent = 'Encrypted before storage and never shown in full again.';
  }
  modal.classList.add('open');
}

function closeApiProviderModal() {
  document.getElementById('apiProviderModal').classList.remove('open');
}

async function saveApiProvider() {
  const id      = document.getElementById('apId').value;
  const name    = document.getElementById('apNameInput').value.trim();
  const baseUrl = document.getElementById('apBaseUrl').value.trim();
  if (!name)    return showToast('Provider name is required', 'warning');
  if (!baseUrl) return showToast('Base URL is required', 'warning');

  const payload = {
    name,
    baseUrl,
    authHeader: document.getElementById('apAuthHeader').value.trim() || 'x-api-key',
    notes: document.getElementById('apNotes').value.trim(),
    enabled: document.getElementById('apEnabled').checked
  };
  const key = document.getElementById('apApiKey').value;
  if (key) payload.apiKey = key; // omitted when blank so the stored key is kept

  const btn = document.getElementById('apSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    if (id) await api('PATCH', '/admin/api-providers/' + id, payload);
    else    await api('POST', '/admin/api-providers', payload);
    showToast(id ? 'Provider updated' : 'Provider added', 'success');
    closeApiProviderModal();
    loadApiProviders();
  } catch (err) {
    showToast(err.message || 'Failed to save provider', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Provider';
  }
}

async function toggleApiProvider(id) {
  try {
    await api('PATCH', '/admin/api-providers/' + id + '/toggle');
    loadApiProviders();
  } catch (err) {
    showToast(err.message || 'Failed to toggle provider', 'error');
  }
}

async function deleteApiProvider(id) {
  if (!confirm('Delete this provider? Products assigned to it will need reassigning.')) return;
  try {
    await api('DELETE', '/admin/api-providers/' + id);
    showToast('Provider deleted', 'success');
    loadApiProviders();
  } catch (err) {
    showToast(err.message || 'Failed to delete provider', 'error');
  }
}

let _adminUsersCache = [];

async function buildAdminUsers(filter='') {
  const tbody = document.getElementById('adminUsersBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--txt-4);padding:26px">Loading…</td></tr>`;
  try {
    const res = await api('GET', '/admin/users' + (filter ? '?search=' + encodeURIComponent(filter) : ''));
    _adminUsersCache = res?.users || [];
    renderAdminUsers(_adminUsersCache);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--error);padding:26px">${escapeHTML(err.message || 'Failed to load users')}</td></tr>`;
  }
}

function renderAdminUsers(users) {
  const tbody = document.getElementById('adminUsersBody');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--txt-4);padding:26px">No users yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = users.map(u => {
    const banned = u.status === 'banned';
    const stBadge = banned ? '<span class="badge" style="background:rgba(239,68,68,.15);color:var(--error)">Banned</span>'
      : u.status === 'active' ? '<span class="badge badge-success">Active</span>'
      : '<span class="badge">Unverified</span>';
    const joined = u.joined ? new Date(u.joined).toISOString().slice(0, 10) : '—';
    return `<tr>
      <td><input type="checkbox" style="accent-color:var(--p-500)"/></td>
      <td><div style="font-weight:600">${escapeHTML(u.name)}</div><div style="font-size:.75rem;color:var(--txt-4)">${escapeHTML(u.email)}</div></td>
      <td style="color:var(--txt-3)">${escapeHTML(u.email)}</td>
      <td style="color:${u.balance>0?'var(--success)':'var(--txt-4)'}">${fmtNaira(u.balance)}</td>
      <td>${u.orders}</td>
      <td style="color:var(--txt-4);font-size:.82rem">${joined}</td>
      <td>${stBadge}</td>
      <td style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" onclick="showToast('User: ${escapeHTML(u.email)}','info')">View</button>
        ${u.role === 'admin' ? '' : `<button class="btn btn-outline btn-sm" style="color:${banned?'var(--success)':'var(--error)'}" onclick="toggleAdminUserBan('${u.id}')">${banned?'Unban':'Ban'}</button>`}
      </td>
    </tr>`;
  }).join('');
}

function filterAdminUsers(val) { buildAdminUsers(val); }

async function toggleAdminUserBan(id) {
  try {
    await api('PATCH', '/admin/users/' + id + '/ban');
    buildAdminUsers();
  } catch (err) {
    showToast(err.message || 'Failed to update user', 'error');
  }
}

const pricingRows = [
  { country:'🇺🇸 United States', wa:0.12, sms:0.08, provider:'5SIM',        markup:35 },
  { country:'🇬🇧 United Kingdom', wa:0.10, sms:0.07, provider:'5SIM',        markup:40 },
  { country:'🇩🇪 Germany',        wa:0.10, sms:0.07, provider:'SMS-Activate', markup:38 },
  { country:'🇮🇳 India',          wa:0.08, sms:0.05, provider:'5SIM',        markup:30 },
  { country:'🇧🇷 Brazil',         wa:0.09, sms:0.06, provider:'5SIM',        markup:32 },
  { country:'🇳🇬 Nigeria',        wa:0.08, sms:0.05, provider:'SMS-Activate', markup:28 },
  { country:'🇷🇺 Russia',         wa:0.09, sms:0.06, provider:'SMS-Activate', markup:35 },
  { country:'🇫🇷 France',         wa:0.11, sms:0.07, provider:'5SIM',        markup:40 },
];

function buildAdminPricing() {
  const tbody = document.getElementById('adminPricingBody');
  if (!tbody) return;
  tbody.innerHTML = pricingRows.map(r => `
    <tr>
      <td>${r.country}</td>
      <td><input type="number" class="form-input" value="${r.wa}" step="0.01" style="width:80px;padding:6px 8px;font-size:.82rem"/></td>
      <td><input type="number" class="form-input" value="${r.sms}" step="0.01" style="width:80px;padding:6px 8px;font-size:.82rem"/></td>
      <td style="color:var(--txt-4)">${r.provider}</td>
      <td><input type="number" class="form-input" value="${r.markup}" style="width:70px;padding:6px 8px;font-size:.82rem"/>%</td>
      <td><div class="provider-toggle on" style="position:static" onclick="this.classList.toggle('on')"></div></td>
    </tr>`).join('');
}

async function buildAdminOrders() {
  const tbody = document.getElementById('adminOrdersBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--txt-4);padding:26px">Loading…</td></tr>`;
  try {
    const res = await api('GET', '/admin/orders');
    renderAdminOrders(res?.orders || []);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--error);padding:26px">${escapeHTML(err.message || 'Failed to load orders')}</td></tr>`;
  }
}

function renderAdminOrders(orders) {
  const tbody = document.getElementById('adminOrdersBody');
  if (!tbody) return;
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--txt-4);padding:26px">No orders yet.</td></tr>`;
    return;
  }
  const statusMap = { completed:'badge-success', received:'badge-success', active:'badge-purple', expired:'', refunded:'', cancelled:'', pending:'' };
  const colorMap  = { completed:'var(--success)', received:'var(--success)', active:'var(--p-300)', expired:'var(--txt-4)', refunded:'var(--warning)', cancelled:'var(--error)', pending:'var(--txt-4)' };
  tbody.innerHTML = orders.map(o => `<tr>
    <td style="font-family:var(--font-head);font-size:.78rem">${escapeHTML(o.id)}</td>
    <td style="color:var(--txt-3);font-size:.82rem">${escapeHTML(o.user)}</td>
    <td>${escapeHTML(o.service || '')}</td>
    <td style="font-family:var(--font-head);font-size:.82rem;color:var(--p-200)">${escapeHTML(o.number || '')}</td>
    <td>${escapeHTML(o.country || '')}</td>
    <td>${fmtNaira(o.cost)}</td>
    <td style="color:var(--txt-4)">${escapeHTML(o.provider || '')}</td>
    <td><span class="badge ${statusMap[o.status]||''}" style="color:${colorMap[o.status]||'var(--txt-4)'}">${escapeHTML((o.status||'').charAt(0).toUpperCase()+(o.status||'').slice(1))}</span></td>
    <td style="color:var(--txt-4);font-size:.78rem">${o.date ? new Date(o.date).toLocaleString() : '—'}</td>
  </tr>`).join('');
}

// Add webhook dialog
function showAddWebhookModal() {
  const url = prompt('Enter your endpoint URL (must be HTTPS):');
  if (url && url.startsWith('https://')) {
    showToast('Webhook endpoint added: ' + url, 'success');
  } else if (url) {
    showToast('URL must start with https://', 'error');
  }
}


// ── CONTACT FORM ───────────────────────────────────────────
function submitContactForm(e) {
  e.preventDefault();
  const name    = document.getElementById('cfName')?.value.trim();
  const email   = document.getElementById('cfEmail')?.value.trim();
  const subject = document.getElementById('cfSubject')?.value;
  const message = document.getElementById('cfMessage')?.value.trim();

  if (!name || !email || !message) {
    showToast('Please fill in all required fields.', 'error');
    return;
  }

  // Build WhatsApp deep-link message as fallback (no backend yet)
  const text = encodeURIComponent(
    `*DonPeeSMS Contact Form*\n\nName: ${name}\nEmail: ${email}\nSubject: ${subject || 'General'}\n\nMessage:\n${message}`
  );
  window.open(`https://wa.me/2347084869630?text=${text}`, '_blank');

  showToast('Message sent! We will respond shortly.', 'success');
  e.target.reset();
}

// ── AVAILABILITY STATUS ─────────────────────────────────────
function updateAvailability() {
  const el = document.getElementById('availStatus');
  if (!el) return;
  // Business hours: 8 AM – 10 PM WAT (UTC+1)
  const watHour = (new Date().getUTCHours() + 1) % 24;
  const online  = watHour >= 8 && watHour < 22;
  el.textContent = online ? 'We are Online now' : 'Currently Offline — leaves a message';
  const dot = el.previousElementSibling;
  if (dot) dot.style.background = online ? 'var(--success)' : 'var(--warning, #f59e0b)';
}

// ── INIT ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  buildCountriesScroll();
  buildAppChips();
  buildProductFilters();
  buildProducts();
  loadLiveProducts(); // swaps in admin-managed products once fetched
  buildFAQ();
  buildParticles();
  // Convert all hard-coded "$N" text in the static HTML to Naira.
  // Runs after the builders above so their injected content is covered.
  nairaifyStaticText(document.body);
  updateTopupSummary(10);
  initVerifyStageInteraction();
  initPWA();
  updateNotifBadge();
  updateAvailability();
  setInterval(updateAvailability, 60_000);
  // Auto-login if token exists
  initAuth();
});
