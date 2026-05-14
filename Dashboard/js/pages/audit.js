import { supabase }                              from '../config.js';
import { formatDateTime, timeAgo, escHtml }      from '../ui.js';
import { CONFIG }                                from '../config.js';

let currentUser  = null;
let realtimeSub  = null;
let currentPage  = 0;
const PAGE_SIZE  = 50;
let filters      = { eventType: '', entityType: '', actorEmail: '', dateFrom: '', dateTo: '' };
let totalCount   = 0;

// ── Entry point ───────────────────────────────────────────
export async function init(user, container) {
  currentUser = user;
  currentPage = 0;
  container.innerHTML = getShell();
  setupControls();
  await Promise.all([loadStats(), loadLog()]);
  subscribeRealtime();
}

export function destroy() {
  if (realtimeSub) { supabase.removeChannel(realtimeSub); realtimeSub = null; }
}

// ── Shell ─────────────────────────────────────────────────
function getShell() {
  return `
  <div class="al-layout">

    <!-- Stats row -->
    <div class="al-stats" id="alStats">
      <div class="loader-spinner center-spinner"></div>
    </div>

    <!-- Filters -->
    <div class="panel">
      <div class="panel-header">
        <span>🔍 Filters</span>
        <button class="btn-outline" id="alResetFilters">Reset</button>
      </div>
      <div class="al-filters">
        <select id="alEventType" class="filter-select">
          <option value="">All Event Types</option>
          <optgroup label="Requests">
            <option value="request_created">request_created</option>
            <option value="request_updated">request_updated</option>
          </optgroup>
          <optgroup label="Approvals">
            <option value="hr_approval_requested">hr_approval_requested</option>
            <option value="hr_approved">hr_approved</option>
            <option value="hr_rejected">hr_rejected</option>
            <option value="it_approval_requested">it_approval_requested</option>
            <option value="it_approved">it_approved</option>
            <option value="mgr_approval_requested">mgr_approval_requested</option>
            <option value="mgr_approved">mgr_approved</option>
            <option value="all_approvals_complete">all_approvals_complete</option>
            <option value="approval_escalated">approval_escalated</option>
          </optgroup>
          <optgroup label="Provisioning">
            <option value="provisioning_started">provisioning_started</option>
            <option value="provisioning_complete">provisioning_complete</option>
            <option value="user_created">user_created</option>
            <option value="license_assigned">license_assigned</option>
          </optgroup>
          <optgroup label="System">
            <option value="workflow_failed">workflow_failed</option>
            <option value="error_logged">error_logged</option>
          </optgroup>
        </select>

        <select id="alEntityType" class="filter-select">
          <option value="">All Entity Types</option>
          <option value="onboarding_request">onboarding_request</option>
          <option value="employee">employee</option>
          <option value="approval_step">approval_step</option>
          <option value="provisioning_task">provisioning_task</option>
        </select>

        <input type="text" id="alActorEmail" class="search-input"
          placeholder="Filter by actor email…" style="max-width:220px;" />

        <input type="date" id="alDateFrom" class="filter-select" title="From date" />
        <input type="date" id="alDateTo"   class="filter-select" title="To date" />

        <button class="btn-outline" id="alExportCSV">⬇ Export CSV</button>
      </div>
    </div>

    <!-- Log table -->
    <div class="panel">
      <div class="panel-header">
        <span>Audit Trail</span>
        <span class="panel-sub" id="alCount"></span>
      </div>
      <div class="al-table-wrap">
        <table class="req-table" id="alTable">
          <thead>
            <tr>
              <th>Time</th>
              <th>Event Type</th>
              <th>Entity</th>
              <th>Description</th>
              <th>Actor</th>
              <th>Request</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="alTableBody">
            <tr><td colspan="7" class="tbl-empty">
              <div class="loader-spinner center-spinner"></div>
            </td></tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="al-pagination" id="alPagination"></div>
    </div>

    <!-- Detail modal -->
    <div id="alModal" class="pv-modal hidden">
      <div class="pv-modal-inner">
        <div class="pv-modal-header">
          <span>Audit Entry Detail</span>
          <button id="alModalClose" class="close-btn">✕</button>
        </div>
        <div id="alModalBody" class="pv-modal-body"></div>
      </div>
    </div>

  </div>`;
}

// ── Load stats ────────────────────────────────────────────
async function loadStats() {
  try {
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const since7d  = new Date(Date.now() - 7 * 86400000).toISOString();

    const [
      { count: total },
      { count: last24h },
      { count: last7d },
      { count: errCount }
    ] = await Promise.all([
      supabase.from('audit_log')
        .select('*', { count: 'exact', head: true }),
      supabase.from('audit_log')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', since24h),
      supabase.from('audit_log')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', since7d),
      supabase.from('error_log')
        .select('*', { count: 'exact', head: true })
        .eq('resolved', false)
    ]);

    document.getElementById('alStats').innerHTML = `
      ${alStatCard('Total Events',    total   ?? 0, '📋', 'blue')}
      ${alStatCard('Last 24 Hours',   last24h ?? 0, '🕐', 'yellow')}
      ${alStatCard('Last 7 Days',     last7d  ?? 0, '📅', 'purple')}
      ${alStatCard('Unresolved Errors', errCount ?? 0, '⚠️',
          errCount > 0 ? 'red' : 'green')}
    `;
  } catch (e) {
    document.getElementById('alStats').innerHTML =
      `<p class="err-txt">Failed to load stats: ${escHtml(e.message)}</p>`;
  }
}

// ── Load log ──────────────────────────────────────────────
async function loadLog() {
  const tbody = document.getElementById('alTableBody');
  tbody.innerHTML = `<tr><td colspan="7" class="tbl-empty">
    <div class="loader-spinner center-spinner"></div></td></tr>`;

  try {
    let query = supabase
      .from('audit_log')
      .select(`
        id, event_type, entity_type, entity_id,
        actor_type, actor_email, description,
        metadata, before_state, after_state,
        ip_address, n8n_workflow_id, n8n_execution_id,
        request_id, created_at,
        onboarding_requests ( request_code )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE - 1);

    if (filters.eventType)  query = query.eq('event_type', filters.eventType);
    if (filters.entityType) query = query.eq('entity_type', filters.entityType);
    if (filters.actorEmail) query = query.ilike('actor_email', `%${filters.actorEmail}%`);
    if (filters.dateFrom)   query = query.gte('created_at', filters.dateFrom);
    if (filters.dateTo)     query = query.lte('created_at', filters.dateTo + 'T23:59:59Z');

    const { data, error, count } = await query;
    if (error) throw error;

    totalCount = count || 0;
    document.getElementById('alCount').textContent =
      `${totalCount.toLocaleString()} event${totalCount !== 1 ? 's' : ''}`;

    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="tbl-empty">
        No audit entries match your filters.</td></tr>`;
      renderPagination();
      return;
    }

    tbody.innerHTML = data.map(ev => `
      <tr class="req-row al-row" data-id="${ev.id}">
        <td style="white-space:nowrap;">
          <div style="font-size:.85rem;">${formatDateTime(ev.created_at)}</div>
          <div class="emp-email">${timeAgo(ev.created_at)}</div>
        </td>
        <td>
          <span class="event-badge ${eventBadgeClass(ev.event_type)}">
            ${escHtml(ev.event_type)}
          </span>
        </td>
        <td>
          <span class="entity-tag">${escHtml(ev.entity_type)}</span>
        </td>
        <td>
          <div class="al-desc">${escHtml(ev.description)}</div>
        </td>
        <td>
          <div style="font-size:.85rem;">${escHtml(ev.actor_email || '—')}</div>
          <div class="emp-email">${escHtml(ev.actor_type || '')}</div>
        </td>
        <td>
          <span class="req-code" style="font-size:.8rem;">
            ${escHtml(ev.onboarding_requests?.request_code || '—')}
          </span>
        </td>
        <td>
          <button class="btn-outline al-detail-btn"
            data-id="${ev.id}" style="font-size:.78rem;padding:3px 8px;">
            Detail
          </button>
        </td>
      </tr>`).join('');

    // Wire detail buttons
    tbody.querySelectorAll('.al-detail-btn').forEach(btn =>
      btn.addEventListener('click', () => openDetail(btn.dataset.id, data)));

    renderPagination();

  } catch (e) {
    tbody.innerHTML =
      `<tr><td colspan="7" class="tbl-empty err-txt">
        Failed to load audit log: ${escHtml(e.message)}</td></tr>`;
  }
}

// ── Open detail modal ─────────────────────────────────────
function openDetail(id, rows) {
  const ev = rows.find(r => r.id === id);
  if (!ev) return;

  document.getElementById('alModalBody').innerHTML = `
    <div class="err-modal-section">
      <div class="err-modal-label">Event</div>
      <div class="err-modal-value">
        <span class="event-badge ${eventBadgeClass(ev.event_type)}">
          ${escHtml(ev.event_type)}
        </span>
      </div>
    </div>

    <div class="err-modal-section">
      <div class="err-modal-label">Description</div>
      <div class="err-modal-value">${escHtml(ev.description)}</div>
    </div>

    <div class="err-modal-section">
      <div class="err-modal-label">Actor</div>
      <div class="err-modal-value">
        ${escHtml(ev.actor_email || '—')}
        <span class="emp-email"> · ${escHtml(ev.actor_type || '')}</span>
      </div>
    </div>

    <div class="err-modal-section">
      <div class="err-modal-label">Entity</div>
      <div class="err-modal-value">
        ${escHtml(ev.entity_type)} ·
        <span class="req-code">${escHtml(ev.entity_id || '—')}</span>
      </div>
    </div>

    <div class="err-modal-section">
      <div class="err-modal-label">Timestamp</div>
      <div class="err-modal-value">${formatDateTime(ev.created_at)}</div>
    </div>

    ${ev.request_id ? `
    <div class="err-modal-section">
      <div class="err-modal-label">Request ID</div>
      <div class="err-modal-value req-code">${escHtml(ev.request_id)}</div>
    </div>` : ''}

    ${ev.n8n_workflow_id ? `
    <div class="err-modal-section">
      <div class="err-modal-label">n8n Workflow / Execution</div>
      <div class="err-modal-value">
        ${escHtml(ev.n8n_workflow_id)} /
        ${escHtml(ev.n8n_execution_id || '—')}
      </div>
    </div>` : ''}

    ${ev.metadata ? `
    <div class="err-modal-section">
      <div class="err-modal-label">Metadata</div>
      <pre class="err-modal-pre">${escHtml(JSON.stringify(ev.metadata, null, 2))}</pre>
    </div>` : ''}

    ${ev.before_state ? `
    <div class="err-modal-section">
      <div class="err-modal-label">Before State</div>
      <pre class="err-modal-pre">${escHtml(JSON.stringify(ev.before_state, null, 2))}</pre>
    </div>` : ''}

    ${ev.after_state ? `
    <div class="err-modal-section">
      <div class="err-modal-label">After State</div>
      <pre class="err-modal-pre">${escHtml(JSON.stringify(ev.after_state, null, 2))}</pre>
    </div>` : ''}

    ${ev.ip_address ? `
    <div class="err-modal-section">
      <div class="err-modal-label">IP Address</div>
      <div class="err-modal-value">${escHtml(ev.ip_address)}</div>
    </div>` : ''}
  `;

  document.getElementById('alModal').classList.remove('hidden');
}

// ── Pagination ────────────────────────────────────────────
function renderPagination() {
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const el = document.getElementById('alPagination');

  if (totalPages <= 1) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <button class="pag-btn" id="pagPrev"
      ${currentPage === 0 ? 'disabled' : ''}>← Prev</button>
    <span class="pag-info">
      Page ${currentPage + 1} of ${totalPages}
      · ${totalCount.toLocaleString()} events
    </span>
    <button class="pag-btn" id="pagNext"
      ${currentPage >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
  `;

  el.querySelector('#pagPrev')?.addEventListener('click', () => {
    if (currentPage > 0) { currentPage--; loadLog(); }
  });
  el.querySelector('#pagNext')?.addEventListener('click', () => {
    if (currentPage < totalPages - 1) { currentPage++; loadLog(); }
  });
}

// ── Controls setup ────────────────────────────────────────
function setupControls() {
  // Filter inputs
  ['alEventType','alEntityType'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', e => {
      filters[id === 'alEventType' ? 'eventType' : 'entityType'] = e.target.value;
      currentPage = 0;
      loadLog();
    });
  });

  let searchTimer;
  document.getElementById('alActorEmail')?.addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filters.actorEmail = e.target.value.trim();
      currentPage = 0;
      loadLog();
    }, 400);
  });

  document.getElementById('alDateFrom')?.addEventListener('change', e => {
    filters.dateFrom = e.target.value;
    currentPage = 0;
    loadLog();
  });

  document.getElementById('alDateTo')?.addEventListener('change', e => {
    filters.dateTo = e.target.value;
    currentPage = 0;
    loadLog();
  });

  // Reset filters
  document.getElementById('alResetFilters')?.addEventListener('click', () => {
    filters = { eventType: '', entityType: '', actorEmail: '', dateFrom: '', dateTo: '' };
    currentPage = 0;
    document.getElementById('alEventType').value  = '';
    document.getElementById('alEntityType').value = '';
    document.getElementById('alActorEmail').value = '';
    document.getElementById('alDateFrom').value   = '';
    document.getElementById('alDateTo').value     = '';
    loadLog();
  });

  // CSV export
  document.getElementById('alExportCSV')?.addEventListener('click', exportCSV);

  // Modal close
  document.getElementById('alModalClose')?.addEventListener('click', () =>
    document.getElementById('alModal').classList.add('hidden'));
  document.getElementById('alModal')?.addEventListener('click', e => {
    if (e.target.id === 'alModal')
      document.getElementById('alModal').classList.add('hidden');
  });
}

// ── CSV Export ────────────────────────────────────────────
async function exportCSV() {
  try {
    let query = supabase
      .from('audit_log')
      .select(`
        id, event_type, entity_type, entity_id,
        actor_type, actor_email, description,
        request_id, n8n_workflow_id,
        n8n_execution_id, ip_address, created_at
      `)
      .order('created_at', { ascending: false })
      .limit(5000);

    if (filters.eventType)  query = query.eq('event_type', filters.eventType);
    if (filters.entityType) query = query.eq('entity_type', filters.entityType);
    if (filters.actorEmail) query = query.ilike('actor_email', `%${filters.actorEmail}%`);
    if (filters.dateFrom)   query = query.gte('created_at', filters.dateFrom);
    if (filters.dateTo)     query = query.lte('created_at', filters.dateTo + 'T23:59:59Z');

    const { data, error } = await query;
    if (error) throw error;

    const headers = [
      'ID','Event Type','Entity Type','Entity ID',
      'Actor Type','Actor Email','Description',
      'Request ID','Workflow','Execution ID',
      'IP Address','Timestamp'
    ];

    const rows = [headers.join(',')];
    data.forEach(ev => {
      rows.push([
        ev.id, ev.event_type, ev.entity_type, ev.entity_id,
        ev.actor_type, ev.actor_email, ev.description,
        ev.request_id, ev.n8n_workflow_id, ev.n8n_execution_id,
        ev.ip_address, ev.created_at
      ].map(v => `"${(v ?? '').toString().replace(/"/g, '""')}"`).join(','));
    });

    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `audit-log-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export failed: ' + e.message);
  }
}

// ── Real-time ─────────────────────────────────────────────
function subscribeRealtime() {
  realtimeSub = supabase
    .channel('audit_page')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'audit_log' },
      () => { if (currentPage === 0) loadLog(); loadStats(); })
    .subscribe();
}

// ── Helpers ───────────────────────────────────────────────
function alStatCard(label, value, icon, color) {
  return `
    <div class="pv-card metric-${color}">
      <div class="metric-icon">${icon}</div>
      <div class="metric-value">${value}</div>
      <div class="metric-label">${label}</div>
    </div>`;
}

function eventBadgeClass(type) {
  if (!type) return 'ev-grey';
  if (type.includes('approved') || type.includes('complete')) return 'ev-green';
  if (type.includes('reject') || type.includes('fail') || type.includes('error')) return 'ev-red';
  if (type.includes('escalat'))  return 'ev-orange';
  if (type.includes('created') || type.includes('submitted')) return 'ev-blue';
  if (type.includes('provisioning') || type.includes('user_created')) return 'ev-purple';
  return 'ev-grey';
}