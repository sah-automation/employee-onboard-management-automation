// ── Toast notifications ────────────────────────────────────
export function showToast(message, type = 'info') {
  // type: 'info' | 'success' | 'error' | 'warning'
  const existing = document.getElementById('toast-container');
  if (!existing) {
    const container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.getElementById('toast-container').appendChild(toast);

  // Auto remove after 4s
  setTimeout(() => toast.remove(), 4000);
}

// ── Page loader ────────────────────────────────────────────
export function showLoader(containerId) {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = `<div class="loader-spinner"></div>`;
}

export function hideLoader(containerId) {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = '';
}

// ── Status badge HTML ──────────────────────────────────────
export function statusBadge(status) {
  const map = {
    submitted:            'badge-blue',
    hr_reviewing:         'badge-yellow',
    hr_approved:          'badge-yellow',
    parallel_approval:    'badge-yellow',
    all_approved:         'badge-green',
    provisioning:         'badge-purple',
    provisioning_complete:'badge-purple',
    welcome_sent:         'badge-purple',
    completed:            'badge-green',
    rejected:             'badge-red',
    escalated:            'badge-orange',
    error:                'badge-red'
  };
  const cls = map[status] || 'badge-grey';
  const label = status.replace(/_/g, ' ');
  return `<span class="badge ${cls}">${label}</span>`;
}

// ── Format date ────────────────────────────────────────────
export function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit'
  });
}

// ── Time ago ───────────────────────────────────────────────
export function timeAgo(iso) {
  if (!iso) return '—';
  const seconds = Math.floor((new Date() - new Date(iso)) / 1000);
  if (seconds < 60)  return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds/3600)}h ago`;
  return `${Math.floor(seconds/86400)}d ago`;
}

// ── Escape HTML (prevent XSS) ──────────────────────────────
export function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}