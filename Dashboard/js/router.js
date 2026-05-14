import { supabase, CONFIG }    from './config.js';
import { requireAuth, logout, getCurrentUser } from './auth.js';
import { showToast }           from './ui.js';
import { initTheme, toggleTheme } from './theme.js';

// ── Page registry ──────────────────────────────────────────
// Each page module exports: init(user) and optionally destroy()
const PAGE_MODULES = {
  overview:     () => import('./pages/overview.js'),
  requests:     () => import('./pages/requests.js'),
  approvals:    () => import('./pages/approvals.js'),
  provisioning: () => import('./pages/provisioning.js'),
  audit:        () => import('./pages/audit.js'),
  settings:     () => import('./pages/settings.js'),
};

const PAGE_TITLES = {
  overview:     'Overview',
  requests:     'Onboarding Requests',
  approvals:    'Approval Queue',
  provisioning: 'Provisioning Monitor',
  audit:        'Audit Log',
  settings:     'Settings',
};

// Pages that are Phase 2 (not built yet)
const PLACEHOLDER_PAGES = [];

let currentUser = null;
let currentPage = null;
let currentModule = null;

// ── Boot ───────────────────────────────────────────────────
async function boot() {
  initTheme();
  const session = await requireAuth();
  if (!session) return;

  currentUser = await getCurrentUser();
  renderUser(currentUser);
  setupLogout();
  setupMobileMenu();
  setupThemeToggle();
  await checkSimulationMode();
  setupRoleVisibility(currentUser);

  // Route to initial page
  const hash = location.hash.replace('#', '') || 'overview';
  await navigate(hash);

  // Listen for hash changes
  window.addEventListener('hashchange', () => {
    const page = location.hash.replace('#', '') || 'overview';
    navigate(page);
  });
}

// ── Theme Toggle ──────────────────────────────────────────
function setupThemeToggle() {
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.addEventListener('click', () => {
      toggleTheme();
    });
  }
}

// ── Navigate to page ───────────────────────────────────────
async function navigate(page) {
  if (!PAGE_MODULES[page]) page = 'overview';

  // Destroy previous page if it has a cleanup
  if (currentModule?.destroy) currentModule.destroy();

  // Update active nav item
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  // Update topbar title
  document.getElementById('pageTitle').textContent =
    PAGE_TITLES[page] || page;

  const container = document.getElementById('pageContent');

  // Placeholder for unbuilt pages
  if (PLACEHOLDER_PAGES.includes(page)) {
    container.innerHTML = `
      <div class="placeholder-page">
        <div class="placeholder-icon">🚧</div>
        <h2>${PAGE_TITLES[page]}</h2>
        <p>This page is coming in Phase 2 of the build.</p>
      </div>`;
    currentPage = page;
    return;
  }

  // Show spinner while loading
  container.innerHTML = `<div class="loader-spinner center-spinner"></div>`;

  try {
    const mod = await PAGE_MODULES[page]();
    currentModule = mod;
    currentPage = page;
    await mod.init(currentUser, container);
  } catch (err) {
    console.error('Page load error:', err);
    container.innerHTML = `
      <div class="error-state">
        <p>⚠️ Failed to load page: ${err.message}</p>
        <button onclick="location.reload()">Reload</button>
      </div>`;
  }
}

// ── Render user info in sidebar ────────────────────────────
function renderUser(user) {
  const initial = (user.name || user.email || '?')[0].toUpperCase();
  document.getElementById('userAvatar').textContent = initial;
  document.getElementById('userName').textContent =
    user.name || user.email;
  document.getElementById('userRole').textContent =
    user.role.charAt(0).toUpperCase() + user.role.slice(1);
}

// ── Logout ─────────────────────────────────────────────────
function setupLogout() {
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (confirm('Sign out of Tanisitech Onboarding?')) {
      await logout();
    }
  });
}

// ── Mobile sidebar toggle ──────────────────────────────────
function setupMobileMenu() {
  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
}

// ── Show/hide elements based on role ──────────────────────
function setupRoleVisibility(user) {
  if (user.role !== CONFIG.roles.ADMIN) {
    document.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = 'none';
    });
  }
}

// ── Simulation mode banner ─────────────────────────────────
export async function checkSimulationMode() {
  try {
    const { data } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'simulation_mode')
      .single();

    const banner = document.getElementById('simBanner');
    if (data?.value === 'true') {
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch (e) {
    console.warn('Could not check simulation_mode:', e.message);
  }
}

// ── Start ──────────────────────────────────────────────────
boot();