import { supabase }                        from '../config.js';
import { statusBadge, formatDateTime, timeAgo, escHtml } from '../ui.js';

// ── Real-time subscription handle ─────────────────────────
let realtimeSub = null;

// ── Entry point called by router ──────────────────────────
export async function init(user, container) {
  container.innerHTML = getShell();
  await Promise.all([
    loadMetrics(),
    loadActivityFeed(),
    loadSystemHealth(),
    loadStatusBreakdown(),
  ]);
  subscribeRealtime();
}

// ── Cleanup when navigating away ──────────────────────────
export function destroy() {
  if (realtimeSub) {
    supabase.removeChannel(realtimeSub);
    realtimeSub = null;
  }
}

// ── Page HTML shell ────────────────────────────────────────
function getShell() {
  return `
    <div class="ov-grid">

      <!-- Metric cards row -->
      <div class="metric-row" id="metricRow">
        ${metricCardSkeleton(4)}
      </div>

      <!-- Middle row: Activity feed + System health -->
      <div class="ov-mid">
        <div class="panel" id="activityPanel">
          <div class="panel-header">
            <span>Recent Activity</span>
            <span class="panel-sub">Last 24 hours</span>
          </div>
          <div id="activityList" class="activity-list">
            <div class="loader-spinner center-spinner"></div>
          </div>
        </div>

        <div class="panel" id="healthPanel">
          <div class="panel-header">
            <span>System Health</span>
            <span class="panel-sub" id="healthUpdated"></span>
          </div>
          <div id="healthList" class="health-list">
            <div class="loader-spinner center-spinner"></div>
          </div>
        </div>
      </div>

      <!-- Bottom row: Requests by status -->
      <div class="panel" id="statusPanel">
        <div class="panel-header">
          <span>Active Requests by Status</span>
        </div>
        <div id="statusBreakdown" class="status-breakdown">
          <div class="loader-spinner center-spinner"></div>
        </div>
      </div>

    </div>`;
}

// ── Load metric cards ─────────────────────────────────────
async function loadMetrics() {
  try {
    const [
      { count: totalActive },
      { count: pendingApprovals },
      { count: provisioningQueue },
      { count: unresolvedErrors }
    ] = await Promise.all([
      supabase.from('onboarding_requests')
        .select('*', { count: 'exact', head: true })
        .not('status', 'in', '("completed","rejected","error")'),

      supabase.from('approval_steps')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending'),

      supabase.from('provisioning_tasks')
        .select('*', { count: 'exact', head: true })
        .in('status', ['pending', 'running', 'retrying']),

      supabase.from('error_log')
        .select('*', { count: 'exact', head: true })
        .eq('resolved', false)
    ]);

    document.getElementById('metricRow').innerHTML = `
      ${metricCard('Active Requests',    totalActive      ?? 0, '📋', 'blue',   '#requests')}
      ${metricCard('Pending Approvals',  pendingApprovals ?? 0, '✅', pendingApprovals > 0 ? 'yellow' : 'green', '#approvals')}
      ${metricCard('Provisioning Queue', provisioningQueue ?? 0,'⚙️', 'purple', '#provisioning')}
      ${metricCard('Unresolved Errors',  unresolvedErrors  ?? 0,'⚠️', unresolvedErrors > 0 ? 'red' : 'green', '#audit')}
    `;
  } catch (e) {
    document.getElementById('metricRow').innerHTML =
      `<p class="err-txt">Failed to load metrics: ${e.message}</p>`;
  }
}

// ── Load activity feed ────────────────────────────────────
async function loadActivityFeed() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('audit_log')
      .select('id,event_type,description,actor_email,actor_type,created_at,request_id')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) throw error;

    const list = document.getElementById('activityList');

    if (!data.length) {
      list.innerHTML = `<p class="empty-txt">No activity in the last 24 hours.</p>`;
      return;
    }

    list.innerHTML = data.map(ev => `
      <div class="activity-item">
        <div class="activity-dot ${eventColor(ev.event_type)}"></div>
        <div class="activity-body">
          <div class="activity-desc">${escHtml(ev.description)}</div>
          <div class="activity-meta">
            <span>${escHtml(ev.actor_email || ev.actor_type || 'system')}</span>
            <span>${timeAgo(ev.created_at)}</span>
          </div>
        </div>
      </div>`).join('');
  } catch (e) {
    document.getElementById('activityList').innerHTML =
      `<p class="err-txt">Failed to load activity: ${e.message}</p>`;
  }
}

// ── Load system health ────────────────────────────────────
async function loadSystemHealth() {
  try {
    // Last run per type
    const { data, error } = await supabase
      .from('integration_runs')
      .select('run_type,status,completed_at,records_processed,records_failed')
      .order('started_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    // Keep only latest per run_type
    const latest = {};
    data.forEach(r => {
      if (!latest[r.run_type]) latest[r.run_type] = r;
    });

    const list = document.getElementById('healthList');

    if (!Object.keys(latest).length) {
      list.innerHTML = `<p class="empty-txt">No integration runs recorded yet.</p>`;
      document.getElementById('healthUpdated').textContent = 'No data';
      return;
    }

    document.getElementById('healthUpdated').textContent =
      `Updated ${timeAgo(Object.values(latest)[0].completed_at)}`;

    list.innerHTML = Object.entries(latest).map(([type, run]) => `
      <div class="health-item">
        <div class="health-name">${formatRunType(type)}</div>
        <div class="health-right">
          <span class="badge ${run.status === 'success' ? 'badge-green'
            : run.status === 'running'  ? 'badge-blue'
            : run.status === 'partial'  ? 'badge-yellow'
            : 'badge-red'}">${run.status}</span>
          <span class="health-time">${timeAgo(run.completed_at)}</span>
        </div>
      </div>`).join('');

    // Also show unresolved error count
    const { count } = await supabase
      .from('error_log')
      .select('*', { count: 'exact', head: true })
      .eq('resolved', false)
      .in('severity', ['critical', 'high']);

    if (count > 0) {
      list.innerHTML += `
        <div class="health-alert">
          ⚠️ ${count} unresolved critical/high error${count > 1 ? 's' : ''} —
          <a href="#audit">Review in Audit Log →</a>
        </div>`;
    }

  } catch (e) {
    document.getElementById('healthList').innerHTML =
      `<p class="err-txt">Failed to load system health: ${e.message}</p>`;
  }
}

// ── Load status breakdown ─────────────────────────────────
async function loadStatusBreakdown() {
  try {
    const { data, error } = await supabase
      .from('onboarding_requests')
      .select('status')
      .not('status', 'in', '("completed","rejected")');

    if (error) throw error;

    const counts = {};
    data.forEach(r => {
      counts[r.status] = (counts[r.status] || 0) + 1;
    });

    const el = document.getElementById('statusBreakdown');

    if (!Object.keys(counts).length) {
      el.innerHTML = `<p class="empty-txt">No active requests.</p>`;
      return;
    }

    el.innerHTML = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `
        <div class="status-row">
          <div class="status-label">${statusBadge(status)}</div>
          <div class="status-bar-wrap">
            <div class="status-bar" style="width:${Math.min(count * 40, 100)}%"></div>
          </div>
          <div class="status-count">${count}</div>
        </div>`).join('');

  } catch (e) {
    document.getElementById('statusBreakdown').innerHTML =
      `<p class="err-txt">Failed to load breakdown: ${e.message}</p>`;
  }
}

// ── Real-time subscription ────────────────────────────────
function subscribeRealtime() {
  realtimeSub = supabase
    .channel('overview_updates')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'onboarding_requests' },
      () => {
        loadMetrics();
        loadStatusBreakdown();
      })
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'audit_log' },
      () => loadActivityFeed())
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'integration_runs' },
      () => loadSystemHealth())
    .subscribe();
}

// ── Helpers ───────────────────────────────────────────────
function metricCard(label, value, icon, color, link) {
  return `
    <a href="${link}" class="metric-card metric-${color}">
      <div class="metric-icon">${icon}</div>
      <div class="metric-value">${value}</div>
      <div class="metric-label">${label}</div>
    </a>`;
}

function metricCardSkeleton(n) {
  return Array(n).fill(`<div class="metric-card skeleton"></div>`).join('');
}

function eventColor(type) {
  if (type.includes('error') || type.includes('fail'))    return 'dot-red';
  if (type.includes('approved') || type.includes('complete')) return 'dot-green';
  if (type.includes('escalat'))  return 'dot-orange';
  if (type.includes('reject'))   return 'dot-red';
  if (type.includes('created'))  return 'dot-blue';
  return 'dot-grey';
}

function formatRunType(type) {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}