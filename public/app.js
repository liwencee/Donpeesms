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

// ── API CLIENT ──────────────────────────────────────────────
const API_BASE = '/api';
let _token = localStorage.getItem('donpee_token') || null;

async function api(method, path, body, timeoutMs = 15000) {
  const headers = { 'Content-Type': 'application/json' };
  if (_token) headers['Authorization'] = 'Bearer ' + _token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      credentials: 'include',
      signal: controller.signal,
      body: body ? JSON.stringify(body) : undefined
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { _handleUnauth(); return null; }
    if (!res.ok) throw new Error(data.message || data.error || 'Request failed (' + res.status + ')');
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Request timed out. Check your connection or try again.');
    if (err.message !== 'UNAUTHENTICATED') throw err;
    return null;
  }
}

function _handleUnauth() {
  _token = null;
  state.currentUser = null;
  localStorage.removeItem('donpee_token');
  showPage('login');
  showToast('Session expired. Please sign in again.', 'warning');
}

function _setToken(token) {
  _token = token;
  if (token) localStorage.setItem('donpee_token', token);
  else localStorage.removeItem('donpee_token');
}

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
}

// ── ADMIN AUTH ─────────────────────────────────────────────
function isAdminRoute() {
  return /^\/admin\/?$/i.test(window.location.pathname);
}

async function handleAdminLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('adminLoginBtn');
  const email    = document.getElementById('adminEmail')?.value?.trim();
  const password = document.getElementById('adminPassword')?.value;
  if (!email || !password) return showToast('Enter email and password', 'warning');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Verifying...';
  try {
    const data = await api('POST', '/auth/login', { email, password });
    if (!data) return;
    const user = data.user || {};
    if (user.role !== 'admin') {
      _setToken(null);
      state.currentUser = null;
      showToast('This account does not have admin access.', 'error');
      return;
    }
    _setToken(data.token || data.accessToken);
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
  try { await api('POST', '/auth/logout'); } catch (_e) {}
  _setToken(null);
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
  const pages = ['home','features','howitworks','services','pricing','faq','contact'];

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
}

// ── SET ACTIVE NAV LINK (kept for compatibility) ───────────
function setNavActive(sectionId) {
  document.querySelectorAll('.nav-link[data-section]').forEach(link => {
    link.classList.toggle('active', link.getAttribute('data-section') === sectionId);
  });
}

// ── SMOOTH SCROLL TO SECTION (legacy — kept for in-page use) ─
function scrollTo(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const offset = 80;
  const top = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top, behavior: 'smooth' });
}

function navScrollTo(id) { showLandingPage(id); }

function scrollToTop() { showLandingPage('home'); }

// ── INTERSECTION OBSERVER (disabled — no longer needed) ────
function initNavObserver() { /* replaced by showLandingPage() */ }

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
    const data = await api('POST', '/auth/login', { email, password });
    if (!data) return;
    _setToken(data.token || data.accessToken);
    state.currentUser = data.user;
    await _loadAndRenderUser();
    showPage('dashboard');
    showToast('Welcome back, ' + (data.user?.firstName || 'there') + '! 👋', 'success');
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
    const data = await api('POST', '/auth/register', { firstName, lastName: lastName || '', username: username || email.split('@')[0], email, password });
    if (!data) return;
    _setToken(data.token || data.accessToken);
    state.currentUser = data.user;
    await _loadAndRenderUser();
    showPage('dashboard');
    showToast('Account created! Welcome to DonPeeSMS 🎉', 'success');
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
  try { await api('POST', '/auth/logout'); } catch (_e) {}
  _setToken(null);
  state.currentUser = null;
  state.orders = [];
  state.transactions = [];
  state.walletBalance = 0;
  showPage('landing');
  showLandingPage('home');
  showToast('Signed out successfully', 'info');
}

// ── USER PROFILE ────────────────────────────────────────────
async function _loadAndRenderUser() {
  try {
    if (!state.currentUser) {
      const data = await api('GET', '/auth/me');
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
    if (pVB) pVB.textContent = u.isEmailVerified ? 'Verified Account' : 'Email Not Verified';

    const pfn = document.getElementById('profileFirstName');
    const pln = document.getElementById('profileLastName');
    const pe  = document.getElementById('profileEmail');
    const pun = document.getElementById('profileUsername');
    if (pfn) pfn.value = u.firstName || '';
    if (pln) pln.value = u.lastName  || '';
    if (pe)  pe.value  = u.email     || '';
    if (pun) pun.value = u.username  || '';

    // Wallet balance
    state.walletBalance = parseFloat(u.walletBalance || 0);
    updateWalletDisplay();
  } catch (err) {
    console.error('_loadAndRenderUser:', err.message);
  }
}

async function saveProfile() {
  const btn = document.getElementById('saveProfileBtn');
  const firstName = document.getElementById('profileFirstName')?.value?.trim();
  const lastName  = document.getElementById('profileLastName')?.value?.trim();
  const username  = document.getElementById('profileUsername')?.value?.trim();
  if (!firstName) return showToast('First name is required', 'warning');

  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    const data = await api('PATCH', '/users/me', { firstName, lastName, username });
    if (!data) return;
    state.currentUser = { ...state.currentUser, firstName, lastName, username };
    await _loadAndRenderUser();
    showToast('Profile updated successfully!', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to save profile', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

// ── AUTO-AUTH ON LOAD ────────────────────────────────────────
async function initAuth() {
  // Dedicated /admin route — show the admin gate, never the normal app.
  if (isAdminRoute()) {
    if (_token) {
      try {
        const data = await api('GET', '/auth/me');
        state.currentUser = data?.user || data || null;
      } catch (_e) { _setToken(null); state.currentUser = null; }
    }
    if (state.currentUser && state.currentUser.role === 'admin') showPage('admin');
    else showPage('admin-login');
    return;
  }

  if (!_token) return;
  try {
    const data = await api('GET', '/auth/me');
    if (!data) return;
    state.currentUser = data.user || data;
    await _loadAndRenderUser();
    // If user lands directly on the page and is already logged in, go to dashboard
    const activePage = document.querySelector('.page.active');
    if (!activePage || activePage.id === 'page-landing') {
      showPage('dashboard');
    }
  } catch (_e) {
    _setToken(null);
  }
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
const phoneNumbers = {
  US: [],
  GB: [],
  DE: [],
  IN: [],
  BR: [],
  NG: [],
  RU: [],
  FR: [],
  CA: ['+14165550123', '+16045550199'],
  AU: ['+61412345678', '+61498765432'],
  PK: ['+923001234567', '+923121234567'],
  ID: ['+6281234567890', '+6285234567890'],
  MX: ['+5215512345678'],
  NG2:['+23324123456'],
  KE: ['+254712345678'],
  ZA: ['+27712345678'],
  EG: ['+201012345678'],
  SA: ['+966512345678'],
  AE: ['+971501234567'],
  TR: ['+905321234567'],
  PH: ['+639171234567'],
  VN: ['+84912345678'],
  UA: ['+380501234567']
};

function pickNumber(country) {
  const pool = phoneNumbers[country] || ['+10000000000'];
  return pool[Math.floor(Math.random() * pool.length)];
}

async function buyNumber(type) {
  if (!_token) { showPage('login'); showToast('Please sign in first', 'warning'); return; }
  const countrySelect = document.getElementById(type === 'whatsapp' ? 'waCountry' : 'smsCountry');
  const resultDiv     = document.getElementById(type === 'whatsapp' ? 'waResult'  : 'smsResult');
  const btn           = document.getElementById(type === 'whatsapp' ? 'buyWABtn'  : 'buySMSBtn');
  if (!countrySelect?.value) { showToast('Please select a country first', 'warning'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Finding number...';

  try {
    const data = await api('POST', '/numbers/buy', {
      serviceType: type,
      country: countrySelect.value
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
        const me = await api('GET', '/auth/me');
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
    const me = await api('GET', '/auth/me');
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

// ── SIMULATE OTP ARRIVAL ───────────────────────────────────
function simulateOTP(type, number) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const key = number.replace(/\D/g,'');
  const timerEl = document.getElementById('timer-' + key);
  const parent = timerEl ? timerEl.closest('.number-result') : null;
  if (parent) {
    const otpDiv = document.createElement('div');
    otpDiv.style.cssText = 'margin-top:10px';
    otpDiv.innerHTML = `
      <div style="font-size:.75rem;color:var(--txt-4);margin-bottom:6px;text-transform:uppercase">
        <span class="pulse-ring"></span> OTP Received
      </div>
      <div class="otp-display">${code}</div>
      <div style="text-align:center;margin-top:8px">
        <button class="copy-btn" style="margin:0 auto" onclick="copyText('${code}')">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          Copy OTP
        </button>
      </div>
    `;
    parent.appendChild(otpDiv);
    showToast(`OTP received: ${code}`, 'success', 5000);
  }
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
  const formatted = state.walletBalance.toFixed(2);
  const el = document.getElementById('sidebarBalance');
  if (el) el.textContent = formatted;
  // Also update overview stat
  const stats = document.querySelectorAll('.stat-card-value');
  if (stats[0]) stats[0].textContent = '$' + formatted;
}

function selectTopup(el, amount) {
  el.closest('.topup-grid').querySelectorAll('.topup-amount-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  state.selectedTopup = amount;

  const customWrap = document.getElementById('customAmountWrap');
  if (customWrap) customWrap.classList.toggle('hidden', amount !== 'custom');

  // Update modal summary
  updateTopupSummary(amount === 'custom' ? 10 : parseFloat(amount));
}

function updateTopupSummary(amount) {
  const bonus = amount >= 100 ? amount * 0.20 : amount >= 50 ? amount * 0.15 : amount >= 25 ? amount * 0.10 : 0;
  const total = amount + bonus;
  const amtEl = document.getElementById('modalAmountDisplay');
  const bonusEl = document.getElementById('modalBonus');
  const totalEl = document.getElementById('modalTotal');
  if (amtEl) amtEl.textContent = `$${amount.toFixed(2)}`;
  if (bonusEl) bonusEl.textContent = bonus > 0 ? `+$${bonus.toFixed(2)}` : '+$0.00';
  if (totalEl) totalEl.textContent = `$${total.toFixed(2)}`;
}

function openTopupModal() {
  document.getElementById('topupModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeTopupModal() {
  document.getElementById('topupModal').classList.remove('open');
  document.body.style.overflow = '';
}

function selectPayMethod(el) {
  el.closest('.payment-methods').querySelectorAll('.pay-method').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
}

async function processTopup() {
  const amount = state.selectedTopup === 'custom'
    ? parseFloat(document.getElementById('customAmount')?.value || 10)
    : parseFloat(state.selectedTopup);

  if (!amount || amount < 1) {
    showToast('Please enter a valid amount (min $1)', 'warning');
    return;
  }

  const bonus = amount >= 100 ? amount * 0.20 : amount >= 50 ? amount * 0.15 : amount >= 25 ? amount * 0.10 : 0;
  const total = amount + bonus;

  // Detect selected payment method
  const selected = document.querySelector('.pay-method.selected');
  const method = selected?.dataset?.method || 'nowpayments';
  const payCurrency = selected?.dataset?.currency || 'USDT';

  closeTopupModal();
  showToast('Redirecting to payment gateway...', 'info');

  try {
    const data = await api('POST', '/wallet/topup', { amount, method, payCurrency });
    if (!data) return;
    // Redirect to payment URL returned by backend
    const url = data.paymentUrl || data.url || data.checkoutUrl || data.invoiceUrl;
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
  const cost    = o.userCost != null ? '$' + parseFloat(o.userCost).toFixed(2) : (o.cost || '—');
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
  const amt    = tx.amount != null ? (parseFloat(tx.amount) >= 0 ? '+$' : '-$') + Math.abs(parseFloat(tx.amount)).toFixed(2) : '—';
  const isPos  = parseFloat(tx.amount || 0) >= 0;
  const method = tx.method || tx.paymentMethod || 'Wallet';
  const bal    = tx.balanceAfter != null ? '$' + parseFloat(tx.balanceAfter).toFixed(2) : '—';
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
  { q:'What payment methods are accepted?', a:'We accept USDT (TRC20/ERC20), Bitcoin, Ethereum, BNB, Litecoin, PayPal, bank transfers, Visa, and Mastercard. Crypto payments are instant with zero extra fees. Your wallet balance never expires.' },
  { q:'Is there an API for bulk purchases?', a:'Yes! Our full REST API lets you automate number purchases, poll OTP status in real time, receive instant webhook events, and manage your account programmatically. API docs are in your dashboard under "API Access".' },
  { q:'Are the numbers real and private?', a:'Yes. All numbers come from legitimate telecom providers worldwide. Each number is exclusively assigned to one user per session — never shared. After your session ends, the number enters a cooldown before being reused.' },
  { q:'Which apps and services can I verify?', a:'Our numbers work with WhatsApp, Telegram, Google, Facebook, Instagram, TikTok, Discord, Twitter/X, Tinder, Snapchat, Amazon, Microsoft, Coinbase, Binance, and 500+ other services. Any service that accepts an international number will work.' },
  { q:'Can I reuse the same number?', a:'Each number covers one verification session. For multiple accounts or different services, purchase separate numbers. This ensures your privacy and prevents conflicts between users.' },
  { q:'Does my wallet balance expire?', a:'Never. Your balance carries forward indefinitely. Deposit once, spend it over months or years across any number of purchases. No inactivity fees or balance resets.' },
  { q:'What is the minimum deposit?', a:'Just $1. This lets you try the service risk-free. For bigger savings, our Pro ($25 → $27.50 credit) and Business ($100 → $120 credit) bundles include 10% and 20% bonus credits respectively.' },
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
      statBalance:      '$' + parseFloat(s.walletBalance || 0).toFixed(2),
      statOrders:       s.totalOrders || 0,
      statCompleted:    s.completedOrders || 0,
      statSpent:        '$' + parseFloat(s.totalSpent || 0).toFixed(2)
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
    reply: `Our numbers start from as low as <strong>$0.10 per use</strong>! 🎉<br><br>
      • <strong>Basic SMS</strong> – from $0.10<br>
      • <strong>WhatsApp numbers</strong> – from $0.25<br>
      • <strong>Premium countries (US/UK)</strong> – from $0.50<br><br>
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
      <strong>2.</strong> Top up your wallet (from $1)<br>
      <strong>3.</strong> Pick a country + service<br>
      <strong>4.</strong> Receive your OTP instantly<br><br>
      No ID, no KYC, no waiting — just instant delivery! 🚀`,
    wa: 'Hi DonPeeSMS, I want to understand how it works'
  },
  {
    keys: ['pay','payment','crypto','bitcoin','btc','card','paypal','usdt','ethereum','deposit','fund','wallet','top up'],
    reply: `We accept multiple payment methods: 💳<br><br>
      • <strong>Crypto</strong> – Bitcoin, USDT, Ethereum & more<br>
      • <strong>Debit/Credit Card</strong> – Visa, Mastercard<br>
      • <strong>PayPal</strong><br>
      • <strong>Bank Transfer</strong><br><br>
      All payments are secure and instant. Your wallet is credited immediately! 🔒`,
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
    const data = labels.map(()=>Math.floor(Math.random()*80+20));
    const ch = new Chart(revEl, {
      type:'line',
      data:{
        labels,
        datasets:[{
          label:'Revenue ($)',
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
          y:{ grid:{color:c.grid}, ticks:{color:c.tick,callback:v=>'$'+v} }
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
          data:[93.6, 4.2, 2.2],
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
          { label:'WhatsApp', data:[28,35,42,39,47,55], backgroundColor:'rgba(37,211,102,.75)', borderRadius:4 },
          { label:'SMS',      data:[14,18,22,20,28,31], backgroundColor:'rgba(139,92,246,.75)', borderRadius:4 }
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
          data:[182,147,96,84,72,68,54],
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
          data:[24,38,29,45,52,48,37],
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
          y:{ grid:{color:c.grid}, ticks:{color:c.tick,callback:v=>'$'+v} }
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
          y:{ grid:{color:c.grid}, ticks:{color:c.tick,callback:v=>'$'+v.toLocaleString()}, stacked:true }
        }
      }
    });
    window._charts.push(ch);
  }
}

// ══════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════
const adminSections = ['overview','users','pricing','providers','orders','revenue','settings'];
const adminTitles = {
  'overview':'Admin Overview','users':'User Management','pricing':'Pricing Management',
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

  if (section === 'overview') { setTimeout(initAdminCharts, 50); }
  if (section === 'users')    buildAdminUsers();
  if (section === 'pricing')  buildAdminPricing();
  if (section === 'orders')   buildAdminOrders();
  if (section === 'revenue')  setTimeout(()=>{ destroyChart('adminChartMonthly'); initAdminCharts(); }, 50);
}

const mockUsers = [
  { id:'USR001', name:'James Mitchell', email:'james@example.com', balance:24.50, orders:47, joined:'2024-12-01', status:'active' },
  { id:'USR002', name:'Amir Khalil',    email:'amir@example.com',  balance:102.00, orders:218, joined:'2024-09-15', status:'active' },
  { id:'USR003', name:'Sofia Carvalho', email:'sofia@example.com', balance:8.20,  orders:31,  joined:'2025-01-20', status:'active' },
  { id:'USR004', name:'Nguyen Van An',  email:'nguyen@example.com',balance:0.00,  orders:5,   joined:'2025-04-10', status:'unverified' },
  { id:'USR005', name:'Ahmed Hassan',   email:'ahmed@example.com', balance:45.80, orders:92,  joined:'2024-11-05', status:'active' },
  { id:'USR006', name:'Maria Garcia',   email:'maria@example.com', balance:0.00,  orders:2,   joined:'2025-05-01', status:'banned' },
  { id:'USR007', name:'Chen Wei',       email:'chen@example.com',  balance:67.30, orders:154, joined:'2024-08-22', status:'active' },
];

function buildAdminUsers(filter='') {
  const tbody = document.getElementById('adminUsersBody');
  if (!tbody) return;
  const users = filter ? mockUsers.filter(u=>u.name.toLowerCase().includes(filter.toLowerCase())||u.email.includes(filter.toLowerCase())) : mockUsers;
  tbody.innerHTML = users.map(u => {
    const stBadge = u.status==='active' ? '<span class="badge badge-success">Active</span>'
      : u.status==='banned' ? '<span class="badge" style="background:rgba(239,68,68,.15);color:var(--error)">Banned</span>'
      : '<span class="badge">Unverified</span>';
    return `<tr>
      <td><input type="checkbox" style="accent-color:var(--p-500)"/></td>
      <td><div style="font-weight:600">${u.name}</div><div style="font-size:.75rem;color:var(--txt-4)">${u.id}</div></td>
      <td style="color:var(--txt-3)">${u.email}</td>
      <td style="color:${u.balance>0?'var(--success)':'var(--txt-4)'}">$${u.balance.toFixed(2)}</td>
      <td>${u.orders}</td>
      <td style="color:var(--txt-4);font-size:.82rem">${u.joined}</td>
      <td>${stBadge}</td>
      <td style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" onclick="showToast('Viewing ${u.name}','info')">View</button>
        <button class="btn btn-outline btn-sm" style="color:${u.status==='banned'?'var(--success)':'var(--error)'}" onclick="showToast('${u.status==='banned'?'User unbanned':'User banned'}','${u.status==='banned'?'success':'warning'}')">${u.status==='banned'?'Unban':'Ban'}</button>
      </td>
    </tr>`;
  }).join('');
}

function filterAdminUsers(val) { buildAdminUsers(val); }

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

function buildAdminOrders() {
  const tbody = document.getElementById('adminOrdersBody');
  if (!tbody) return;
  const sample = [
    { id:'ORD-4892', user:'james@example.com', svc:'WhatsApp', num:'+12025550142', country:'US', cost:0.12, prov:'5SIM',   status:'completed' },
    { id:'ORD-4891', user:'amir@example.com',  svc:'SMS',      num:'+447700900142', country:'GB', cost:0.07, prov:'5SIM',   status:'active' },
    { id:'ORD-4890', user:'sofia@example.com', svc:'SMS',      num:'+4915221234567',country:'DE', cost:0.07, prov:'SA',     status:'expired' },
    { id:'ORD-4889', user:'chen@example.com',  svc:'WhatsApp', num:'+919876543210', country:'IN', cost:0.08, prov:'5SIM',   status:'completed' },
    { id:'ORD-4888', user:'ahmed@example.com', svc:'SMS',      num:'+5511987654321',country:'BR', cost:0.06, prov:'5SIM',   status:'refunded' },
  ];
  const statusMap = { completed:'badge-success', active:'badge-purple', expired:'', refunded:'' };
  const colorMap  = { completed:'var(--success)', active:'var(--p-300)', expired:'var(--txt-4)', refunded:'var(--warning)' };
  tbody.innerHTML = sample.map(o => `<tr>
    <td style="font-family:var(--font-head);font-size:.78rem">${o.id}</td>
    <td style="color:var(--txt-3);font-size:.82rem">${o.user}</td>
    <td>${o.svc}</td>
    <td style="font-family:var(--font-head);font-size:.82rem;color:var(--p-200)">${o.num}</td>
    <td>${o.country}</td>
    <td>$${o.cost.toFixed(2)}</td>
    <td style="color:var(--txt-4)">${o.prov}</td>
    <td><span class="badge ${statusMap[o.status]||''}" style="color:${colorMap[o.status]||'var(--txt-4)'}">${o.status.charAt(0).toUpperCase()+o.status.slice(1)}</span></td>
    <td style="color:var(--txt-4);font-size:.78rem">Just now</td>
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
  buildFAQ();
  buildParticles();
  updateTopupSummary(10);
  initVerifyStageInteraction();
  initNavObserver();
  initPWA();
  updateNotifBadge();
  updateAvailability();
  setInterval(updateAvailability, 60_000);
  // Auto-login if token exists
  initAuth();
});
