import { supabase }                              from '../config.js';
import { statusBadge, formatDateTime, timeAgo,
         escHtml, showToast }                    from '../ui.js';
import { CONFIG }                                from '../config.js';

let currentUser = null;
let realtimeSub = null;
let filterStatus = '';
let filterType   = '';

// ── Entry point ───────────────────────────────────────────
export async function init(user, container) {
  currentUser = user;
  container.innerHTML = getShell();
  setupFilters();
  await Promise.all([loadSummary(), loadTasks()]);
  subscribeRealtime();
}

export function destroy() {
  if (realtimeSub) { supabase.removeChannel(realtimeSub); realtimeSub = null; }
}

// ── Page shell ────────────────────────────────────────────
function getShell() {
  return `
  <div class="pv-layout">

    <!-- Summary cards -->
    <div class="pv-summary" id="pvSummary">
      <div class="loader-spinner center-spinner"></div>
    </div>

    <!-- Toolbar -->
    <div class="req-toolbar">
      <select id="pvFilterStatus" class="filter-select">
        <option value="">All Statuses</option>
        <option value="pending">Pending</option>
        <option value="running">Running</option>
        <option value="success">Success</option>
        <option value="simulated">Simulated</option>
        <option value="failed">Failed</option>
        <option value="retrying">Retrying</option>
        <option value="skipped">Skipped</option>
      </select>

      <select id="pvFilterType" class="filter-select">
        <option value="">All Task Types</option>
        <option value="create_user">Create User</option>
        <option value="assign_license">Assign License</option>
        <option value="add_group">Add Group</option>
        <option value="add_teams_channel">Add Teams Channel</option>
        <option value="setup_onedrive">Setup OneDrive</option>
        <option value="create_planner_tasks">Create Planner Tasks</option>
        <option value="create_sharepoint_folder">SharePoint Folder</option>
      </select>

      <button class="btn-outline" id="pvRefresh">↻ Refresh</button>
    </div>

    <!-- Tasks table -->
    <div class="panel">
      <div class="panel-header">
        <span>Provisioning Tasks</span>
        <span class="panel-sub" id="pvTaskCount"></span>
      </div>
      <div class="pv-table-wrap">
        <table class="req-table" id="pvTable">
          <thead>
            <tr>
              <th>Request</th>
              <th>Employee</th>
              <th>Task Type</th>
              <th>Status</th>
              <th>Retries</th>
              <th>Simulation</th>
              <th>Started</th>
              <th>Completed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="pvTableBody">
            <tr><td colspan="9" class="tbl-empty">
              <div class="loader-spinner center-spinner"></div>
            </td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Error detail modal -->
    <div id="pvErrorModal" class="pv-modal hidden">
      <div class="pv-modal-inner">
        <div class="pv-modal-header">
          <span>Task Error Detail</span>
          <button id="pvModalClose" class="close-btn">✕</button>
        </div>
        <div id="pvModalBody" class="pv-modal-body"></div>
      </div>
    </div>

  </div>`;
}

// ── Load summary cards ────────────────────────────────────
async function loadSummary() {
  try {
    const [
      { count: total },
      { count: pending },
      { count: running },
      { count: failed },
      { count: success },
      { count: simulated }
    ] = await Promise.all([
      supabase.from('provisioning_tasks')
        .select('*', { count: 'exact', head: true }),
      supabase.from('provisioning_tasks')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending'),
      supabase.from('provisioning_tasks')
        .select('*', { count: 'exact', head: true })
        .in('status', ['running', 'retrying']),
      supabase.from('provisioning_tasks')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'failed'),
      supabase.from('provisioning_tasks')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'success'),
      supabase.from('provisioning_tasks')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'simulated')
    ]);

    document.getElementById('pvSummary').innerHTML = `
      ${pvCard('Total Tasks',    total     ?? 0, '📋', 'blue')}
      ${pvCard('Pending',        pending   ?? 0, '⏳', 'yellow')}
      ${pvCard('In Progress',    running   ?? 0, '🔄', 'purple')}
      ${pvCard('Failed',         failed    ?? 0, '❌', failed > 0 ? 'red' : 'green')}
      ${pvCard('Completed',      success   ?? 0, '✅', 'green')}
      ${pvCard('Simulated',      simulated ?? 0, '🧪', 'grey')}
    `;
  } catch (e) {
    document.getElementById('pvSummary').innerHTML =
      `<p class="err-txt">Failed to load summary: ${escHtml(e.message)}</p>`;
  }
}

// ── Load tasks ────────────────────────────────────────────
async function loadTasks() {
  const tbody = document.getElementById('pvTableBody');
  tbody.innerHTML = `<tr><td colspan="9" class="tbl-empty">
    <div class="loader-spinner center-spinner"></div></td></tr>`;

  try {
    let query = supabase
      .from('provisioning_tasks')
      .select(`
        id, task_type, status, retry_count, max_retries,
        is_simulation, started_at, completed_at,
        error_message, payload, result,
        n8n_execution_id, request_id,
        onboarding_requests (
          request_code,
          employees ( first_name, last_name, job_title )
        )
      `)
      .order('created_at', { ascending: false })
      .limit(100);

    if (filterStatus) query = query.eq('status', filterStatus);
    if (filterType)   query = query.eq('task_type', filterType);

    const { data, error } = await query;
    if (error) throw error;

    document.getElementById('pvTaskCount').textContent =
      `${data.length} task${data.length !== 1 ? 's' : ''}`;

    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="tbl-empty">
        No provisioning tasks found.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.map(t => {
      const req = t.onboarding_requests;
      const emp = req?.employees;
      const canRetry = t.status === 'failed' && t.retry_count < t.max_retries;
      const canViewErr = !!t.error_message;

      return `
      <tr class="req-row">
        <td>
          <span class="req-code">
            ${escHtml(req?.request_code || '—')}
          </span>
        </td>
        <td>
          <div class="emp-name">
            ${escHtml(emp?.first_name || '')} ${escHtml(emp?.last_name || '')}
          </div>
          <div class="emp-email">${escHtml(emp?.job_title || '')}</div>
        </td>
        <td>
          <span class="task-type-label">
            ${formatTaskType(t.task_type)}
          </span>
        </td>
        <td>${taskStatusBadge(t.status)}</td>
        <td>
          <span class="${t.retry_count > 0 ? 'retry-warn' : ''}">
            ${t.retry_count} / ${t.max_retries}
          </span>
        </td>
        <td>
          ${t.is_simulation
            ? `<span class="sim-tag">SIM</span>`
            : `<span class="real-tag">REAL</span>`}
        </td>
        <td>${t.started_at   ? timeAgo(t.started_at)   : '—'}</td>
        <td>${t.completed_at ? timeAgo(t.completed_at) : '—'}</td>
        <td>
          <div class="pv-action-btns">
            ${canRetry ? `
              <button class="btn-retry btn-outline"
                data-task-id="${t.id}"
                data-request-id="${t.request_id}"
                title="Retry this task">↻ Retry</button>` : ''}
            ${canViewErr ? `
              <button class="btn-err-detail btn-outline"
                data-task-id="${t.id}"
                data-error="${escHtml(t.error_message)}"
                data-payload='${JSON.stringify(t.payload || {})}'
                title="View error">⚠️ Error</button>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');

    // Wire retry buttons
    tbody.querySelectorAll('.btn-retry').forEach(btn =>
      btn.addEventListener('click', () =>
        retryTask(btn.dataset.taskId, btn.dataset.requestId, btn)));

    // Wire error detail buttons
    tbody.querySelectorAll('.btn-err-detail').forEach(btn =>
      btn.addEventListener('click', () =>
        showErrorModal(btn.dataset.taskId, btn.dataset.error, btn.dataset.payload)));

  } catch (e) {
    tbody.innerHTML =
      `<tr><td colspan="9" class="tbl-empty err-txt">
        Failed to load tasks: ${escHtml(e.message)}</td></tr>`;
  }
}

// ── Retry task ────────────────────────────────────────────
async function retryTask(taskId, requestId, btn) {
  if (!confirm('Retry this provisioning task?')) return;
  btn.disabled = true;
  btn.textContent = 'Retrying…';

  try {
    // Reset task status to pending + increment retry_count
    const { error: e1 } = await supabase
      .from('provisioning_tasks')
      .update({
        status:      'pending',
        error_message: null,
        updated_at:  new Date().toISOString()
      })
      .eq('id', taskId);
    if (e1) throw e1;

    // Trigger WF-04 provisioning webhook for this request
    const { data: setting } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'n8n_base_url')
      .single();

    const n8nBase = setting?.value || '';
    await fetch(`${n8nBase}/webhook/trigger-provisioning`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ request_id: requestId, retry_task_id: taskId })
    });

    showToast('Task queued for retry', 'success');
    setTimeout(() => loadTasks(), 1200);

  } catch (e) {
    showToast(`Retry failed: ${e.message}`, 'error');
    btn.disabled = false;
    btn.textContent = '↻ Retry';
  }
}

// ── Error modal ───────────────────────────────────────────
function showErrorModal(taskId, errorMsg, payloadStr) {
  let payload = {};
  try { payload = JSON.parse(payloadStr); } catch (_) {}

  document.getElementById('pvModalBody').innerHTML = `
    <div class="err-modal-section">
      <div class="err-modal-label">Error Message</div>
      <div class="err-modal-value err-txt">${escHtml(errorMsg)}</div>
    </div>
    ${Object.keys(payload).length ? `
    <div class="err-modal-section">
      <div class="err-modal-label">Task Payload</div>
      <pre class="err-modal-pre">${escHtml(JSON.stringify(payload, null, 2))}</pre>
    </div>` : ''}
    <div class="err-modal-section">
      <div class="err-modal-label">Task ID</div>
      <div class="err-modal-value">${escHtml(taskId)}</div>
    </div>
  `;

  document.getElementById('pvErrorModal').classList.remove('hidden');
}

// ── Filters ───────────────────────────────────────────────
function setupFilters() {
  document.getElementById('pvFilterStatus')
    ?.addEventListener('change', e => {
      filterStatus = e.target.value;
      loadTasks();
    });

  document.getElementById('pvFilterType')
    ?.addEventListener('change', e => {
      filterType = e.target.value;
      loadTasks();
    });

  document.getElementById('pvRefresh')
    ?.addEventListener('click', () =>
      Promise.all([loadSummary(), loadTasks()]));

  // Modal close
  document.getElementById('pvModalClose')
    ?.addEventListener('click', () =>
      document.getElementById('pvErrorModal').classList.add('hidden'));

  document.getElementById('pvErrorModal')
    ?.addEventListener('click', e => {
      if (e.target.id === 'pvErrorModal')
        document.getElementById('pvErrorModal').classList.add('hidden');
    });
}

// ── Real-time ─────────────────────────────────────────────
function subscribeRealtime() {
  realtimeSub = supabase
    .channel('provisioning_page')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'provisioning_tasks' },
      () => Promise.all([loadSummary(), loadTasks()]))
    .subscribe();
}

// ── Helpers ───────────────────────────────────────────────
function pvCard(label, value, icon, color) {
  return `
    <div class="pv-card metric-${color}">
      <div class="metric-icon">${icon}</div>
      <div class="metric-value">${value}</div>
      <div class="metric-label">${label}</div>
    </div>`;
}

function taskStatusBadge(status) {
  const map = {
    pending:   'badge-yellow',
    running:   'badge-blue',
    success:   'badge-green',
    simulated: 'badge-grey',
    failed:    'badge-red',
    retrying:  'badge-orange',
    skipped:   'badge-grey'
  };
  return `<span class="badge ${map[status] || 'badge-grey'}">${status}</span>`;
}

function formatTaskType(t) {
  return (t || '').replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}