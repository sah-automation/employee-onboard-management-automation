import { supabase }                                    from '../config.js';
import { statusBadge, formatDate, formatDateTime,
         timeAgo, escHtml, showToast }                 from '../ui.js';

let currentUser  = null;
let allRequests  = [];
let activeReqId  = null;
let realtimeSub  = null;

// ── Entry point ───────────────────────────────────────────
export async function init(user, container) {
  currentUser = user;
  container.innerHTML = getShell();

  setupFilters();
  setupSearch();
  await loadRequests();
  subscribeRealtime();
}

export function destroy() {
  if (realtimeSub) { supabase.removeChannel(realtimeSub); realtimeSub = null; }
  activeReqId = null;
}

// ── Page shell ────────────────────────────────────────────
function getShell() {
  return `
  <div class="req-layout">

    <!-- Left: table panel -->
    <div class="req-left" id="reqLeft">
      <div class="req-toolbar">
        <input type="search" id="reqSearch"
          placeholder="Search name, code, email…" class="search-input" />

        <select id="filterStatus" class="filter-select">
          <option value="">All Statuses</option>
          <option value="submitted">Submitted</option>
          <option value="hr_reviewing">HR Reviewing</option>
          <option value="hr_approved">HR Approved</option>
          <option value="parallel_approval">Parallel Approval</option>
          <option value="all_approved">All Approved</option>
          <option value="provisioning">Provisioning</option>
          <option value="provisioning_complete">Provisioning Complete</option>
          <option value="welcome_sent">Welcome Sent</option>
          <option value="completed">Completed</option>
          <option value="rejected">Rejected</option>
          <option value="escalated">Escalated</option>
          <option value="error">Error</option>
        </select>

        <select id="filterDept" class="filter-select">
          <option value="">All Departments</option>
        </select>

        <button id="exportBtn" class="btn-outline">⬇ Export CSV</button>
      </div>

      <div class="req-table-wrap">
        <table class="req-table" id="reqTable">
          <thead>
            <tr>
              <th>Request</th>
              <th>Employee</th>
              <th>Role</th>
              <th>Department</th>
              <th>Start Date</th>
              <th>Status</th>
              <th>Submitted</th>
            </tr>
          </thead>
          <tbody id="reqTableBody">
            <tr><td colspan="7" class="tbl-empty">
              <div class="loader-spinner center-spinner"></div>
            </td></tr>
          </tbody>
        </table>
      </div>

      <div class="req-footer" id="reqFooter"></div>
    </div>

    <!-- Right: detail panel (hidden until row clicked) -->
    <aside class="req-detail hidden" id="reqDetail">
      <div id="reqDetailInner"></div>
    </aside>
  </div>`;
}

// ── Load requests ─────────────────────────────────────────
async function loadRequests() {
  try {
    const { data, error } = await supabase
      .from('onboarding_requests')
      .select(`
        id, request_code, status, submitted_by,
        is_simulation, created_at, hr_approved_at,
        provisioned_at, completed_at, rejected_at,
        rejection_reason, notes,
        employees (
          id, employee_code, first_name, last_name,
          personal_email, job_title, work_mode,
          start_date, department_id,
          departments ( name, code )
        ),
        roles ( name )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    allRequests = data;
    populateDeptFilter(data);
    renderTable(data);

  } catch (e) {
    document.getElementById('reqTableBody').innerHTML =
      `<tr><td colspan="7" class="tbl-empty err-txt">
        Failed to load requests: ${escHtml(e.message)}
      </td></tr>`;
  }
}

// ── Render table rows ─────────────────────────────────────
function renderTable(rows) {
  const tbody = document.getElementById('reqTableBody');
  document.getElementById('reqFooter').textContent =
    `${rows.length} record${rows.length !== 1 ? 's' : ''}`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="tbl-empty">
      No requests match your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const emp  = r.employees;
    const dept = emp?.departments?.name || '—';
    const sim  = r.is_simulation
      ? `<span class="sim-tag" title="Simulation">SIM</span>` : '';
    return `
    <tr class="req-row ${activeReqId === r.id ? 'row-active' : ''}"
        data-id="${r.id}" tabindex="0">
      <td>
        <span class="req-code">${escHtml(r.request_code)}</span>
        ${sim}
      </td>
      <td>
        <div class="emp-name">
          ${escHtml(emp?.first_name || '')} ${escHtml(emp?.last_name || '')}
        </div>
        <div class="emp-email">${escHtml(emp?.personal_email || '')}</div>
      </td>
      <td>${escHtml(r.roles?.name || emp?.job_title || '—')}</td>
      <td>${escHtml(dept)}</td>
      <td>${formatDate(emp?.start_date)}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${timeAgo(r.created_at)}</td>
    </tr>`;
  }).join('');

  // Row click → open detail
  tbody.querySelectorAll('.req-row').forEach(row => {
    row.addEventListener('click', () => openDetail(row.dataset.id));
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter') openDetail(row.dataset.id);
    });
  });
}

// ── Open detail panel ─────────────────────────────────────
async function openDetail(requestId) {
  activeReqId = requestId;

  // Highlight active row
  document.querySelectorAll('.req-row').forEach(r =>
    r.classList.toggle('row-active', r.dataset.id === requestId));

  const panel = document.getElementById('reqDetail');
  const inner = document.getElementById('reqDetailInner');
  panel.classList.remove('hidden');
  inner.innerHTML = `<div class="loader-spinner center-spinner"></div>`;

  try {
    // Fetch full request details
    const { data: req, error: e1 } = await supabase
      .from('onboarding_requests')
      .select(`
        *,
        employees (*,  departments(name,code)),
        roles (name, seniority, default_license)
      `)
      .eq('id', requestId)
      .single();
    if (e1) throw e1;

    // Fetch approval steps
    const { data: steps } = await supabase
      .from('approval_steps')
      .select('*')
      .eq('request_id', requestId)
      .order('step_order');

    // Fetch provisioning tasks
    const { data: tasks } = await supabase
      .from('provisioning_tasks')
      .select('*')
      .eq('request_id', requestId)
      .order('task_order');

    // Fetch document checklist
    const { data: docs } = await supabase
      .from('document_checklists')
      .select('*')
      .eq('request_id', requestId)
      .order('created_at');

    inner.innerHTML = buildDetailHTML(req, steps || [], tasks || [], docs || []);

    // Close button
    inner.querySelector('#closeDetail').addEventListener('click', closeDetail);

  } catch (e) {
    inner.innerHTML = `<p class="err-txt" style="padding:24px;">
      Failed to load request: ${escHtml(e.message)}</p>`;
  }
}

// ── Build detail HTML ─────────────────────────────────────
function buildDetailHTML(req, steps, tasks, docs) {
  const emp = req.employees;

  return `
  <div class="detail-wrap">
    <div class="detail-header">
      <div>
        <div class="detail-code">${escHtml(req.request_code)}</div>
        <div style="margin-top:4px;">${statusBadge(req.status)}</div>
      </div>
      <button id="closeDetail" class="close-btn" title="Close">✕</button>
    </div>

    <!-- Employee info -->
    <section class="detail-section">
      <div class="detail-section-title">👤 Employee</div>
      <div class="detail-grid">
        ${detailRow('Name',       `${escHtml(emp.first_name)} ${escHtml(emp.last_name)}`)}
        ${detailRow('Code',        escHtml(emp.employee_code))}
        ${detailRow('Personal Email', escHtml(emp.personal_email))}
        ${detailRow('Work Email',  escHtml(emp.work_email || '—'))}
        ${detailRow('Job Title',   escHtml(emp.job_title))}
        ${detailRow('Department',  escHtml(emp.departments?.name || '—'))}
        ${detailRow('Work Mode',   escHtml(emp.work_mode))}
        ${detailRow('Start Date',  formatDate(emp.start_date))}
        ${detailRow('Manager',     escHtml(emp.manager_email || '—'))}
        ${detailRow('M365 License', escHtml(req.roles?.default_license || '—'))}
      </div>
    </section>

    <!-- Journey timeline -->
    <section class="detail-section">
      <div class="detail-section-title">🗓 Journey Timeline</div>
      <div class="timeline">
        ${timelineItem('Submitted',           req.created_at,             'done')}
        ${timelineItem('HR Review',           req.hr_approved_at,         req.hr_approved_at ? 'done' : req.status === 'rejected' && req.rejection_stage === 'hr_approval' ? 'failed' : 'pending')}
        ${timelineItem('Parallel Approvals',  req.it_approved_at,         req.it_approved_at && req.mgr_approved_at ? 'done' : 'pending')}
        ${timelineItem('Provisioning',        req.provisioned_at,         req.provisioned_at ? 'done' : 'pending')}
        ${timelineItem('Welcome Sent',        req.welcome_sent_at,        req.welcome_sent_at ? 'done' : 'pending')}
        ${timelineItem('Completed',           req.completed_at,           req.completed_at ? 'done' : 'pending')}
        ${req.rejected_at ? timelineItem('Rejected', req.rejected_at, 'failed') : ''}
      </div>
      ${req.rejection_reason ? `
        <div class="rejection-note">
          ❌ Rejection reason: ${escHtml(req.rejection_reason)}
        </div>` : ''}
    </section>

    <!-- Approval steps -->
    <section class="detail-section">
      <div class="detail-section-title">✅ Approval Steps</div>
      ${steps.length ? steps.map(s => `
        <div class="step-card step-${s.status}">
          <div class="step-top">
            <span class="step-type">${formatStepType(s.step_type)}</span>
            <span class="badge ${stepBadgeClass(s.status)}">${s.status}</span>
          </div>
          <div class="step-meta">
            Assignee: <strong>${escHtml(s.assignee_email)}</strong>
          </div>
          <div class="step-meta">
            Due: ${formatDateTime(s.due_at)}
            ${s.responded_at ? ` · Responded: ${formatDateTime(s.responded_at)}` : ''}
          </div>
          ${s.response_note ? `<div class="step-note">"${escHtml(s.response_note)}"</div>` : ''}
        </div>`).join('')
      : `<p class="empty-txt">No approval steps yet.</p>`}
    </section>

    <!-- Provisioning tasks -->
    <section class="detail-section">
      <div class="detail-section-title">⚙️ Provisioning Tasks</div>
      ${tasks.length ? `
        <div class="task-list">
          ${tasks.map(t => `
            <div class="task-row">
              <span class="task-icon">${taskIcon(t.status)}</span>
              <span class="task-name">${formatTaskType(t.task_type)}</span>
              <span class="badge ${taskBadgeClass(t.status)}">${t.status}</span>
              ${t.is_simulation ? `<span class="sim-tag">SIM</span>` : ''}
            </div>`).join('')}
        </div>`
      : `<p class="empty-txt">No provisioning tasks yet.</p>`}
    </section>

    <!-- Document checklist -->
    <section class="detail-section">
      <div class="detail-section-title">📄 Pre-boarding Documents</div>
      ${docs.length ? `
        <div class="doc-list">
          ${docs.map(d => `
            <div class="doc-row">
              <span class="doc-icon">${docIcon(d.status)}</span>
              <span class="doc-name">${escHtml(d.document_name)}</span>
              <span class="badge ${docBadgeClass(d.status)}">${d.status}</span>
            </div>`).join('')}
        </div>`
      : `<p class="empty-txt">No document checklist.</p>`}
    </section>

    <!-- Meta -->
    <section class="detail-section">
      <div class="detail-section-title">ℹ️ Meta</div>
      <div class="detail-grid">
        ${detailRow('Submitted by',   escHtml(req.submitted_by))}
        ${detailRow('Simulation',     req.is_simulation ? '✅ Yes' : '❌ No')}
        ${detailRow('Created',        formatDateTime(req.created_at))}
        ${detailRow('n8n Execution',  escHtml(req.n8n_execution_id || '—'))}
        ${req.notes ? detailRow('Notes', escHtml(req.notes)) : ''}
      </div>
    </section>
  </div>`;
}

function closeDetail() {
  activeReqId = null;
  document.querySelectorAll('.req-row').forEach(r =>
    r.classList.remove('row-active'));
  document.getElementById('reqDetail').classList.add('hidden');
}

// ── Filters ───────────────────────────────────────────────
function setupFilters() {
  ['filterStatus', 'filterDept'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyFilters);
  });
}

function setupSearch() {
  document.getElementById('reqSearch')?.addEventListener('input', applyFilters);
}

function applyFilters() {
  const q     = (document.getElementById('reqSearch')?.value || '').toLowerCase();
  const stat  = document.getElementById('filterStatus')?.value;
  const dept  = document.getElementById('filterDept')?.value;

  const filtered = allRequests.filter(r => {
    const emp  = r.employees;
    const name = `${emp?.first_name} ${emp?.last_name}`.toLowerCase();
    const matchQ = !q
      || name.includes(q)
      || r.request_code?.toLowerCase().includes(q)
      || emp?.personal_email?.toLowerCase().includes(q)
      || emp?.job_title?.toLowerCase().includes(q);
    const matchS = !stat || r.status === stat;
    const matchD = !dept || emp?.departments?.name === dept;
    return matchQ && matchS && matchD;
  });

  renderTable(filtered);
}

function populateDeptFilter(rows) {
  const depts = [...new Set(
    rows.map(r => r.employees?.departments?.name).filter(Boolean)
  )].sort();
  const sel = document.getElementById('filterDept');
  depts.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d; opt.textContent = d;
    sel.appendChild(opt);
  });
}

// ── CSV Export ────────────────────────────────────────────
document.addEventListener('click', e => {
  if (e.target?.id === 'exportBtn') exportCSV();
});

function exportCSV() {
  const q    = (document.getElementById('reqSearch')?.value || '').toLowerCase();
  const stat = document.getElementById('filterStatus')?.value;
  const dept = document.getElementById('filterDept')?.value;

  const rows = allRequests.filter(r => {
    const emp  = r.employees;
    const name = `${emp?.first_name} ${emp?.last_name}`.toLowerCase();
    const matchQ = !q || name.includes(q) || r.request_code?.toLowerCase().includes(q);
    const matchS = !stat || r.status === stat;
    const matchD = !dept || emp?.departments?.name === dept;
    return matchQ && matchS && matchD;
  });

  const headers = [
    'Request Code','Employee Code','First Name','Last Name',
    'Email','Job Title','Department','Work Mode',
    'Start Date','Status','Submitted By','Created At','Simulation'
  ];

  const csvRows = [headers.join(',')];
  rows.forEach(r => {
    const emp = r.employees;
    csvRows.push([
      r.request_code, emp?.employee_code,
      emp?.first_name, emp?.last_name,
      emp?.personal_email, emp?.job_title,
      emp?.departments?.name, emp?.work_mode,
      emp?.start_date, r.status,
      r.submitted_by, r.created_at,
      r.is_simulation
    ].map(v => `"${(v ?? '').toString().replace(/"/g, '""')}"`).join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `tanisitech-requests-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exported', 'success');
}

// ── Real-time ─────────────────────────────────────────────
function subscribeRealtime() {
  realtimeSub = supabase
    .channel('requests_page')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'onboarding_requests' },
      () => loadRequests())
    .subscribe();
}

// ── Small helpers ─────────────────────────────────────────
function detailRow(label, value) {
  return `
    <div class="detail-row">
      <span class="detail-lbl">${label}</span>
      <span class="detail-val">${value}</span>
    </div>`;
}

function timelineItem(label, ts, state) {
  const icon = state === 'done' ? '✅' : state === 'failed' ? '❌' : '⏳';
  return `
    <div class="tl-item tl-${state}">
      <span class="tl-icon">${icon}</span>
      <span class="tl-label">${label}</span>
      <span class="tl-time">${ts ? formatDateTime(ts) : '—'}</span>
    </div>`;
}

function formatStepType(t) {
  return t === 'hr_approval' ? 'HR Approval'
    : t === 'it_approval'   ? 'IT Approval'
    : t === 'mgr_approval'  ? 'Manager Approval'
    : t;
}

function stepBadgeClass(s) {
  return s === 'approved' ? 'badge-green'
    : s === 'rejected'    ? 'badge-red'
    : s === 'escalated'   ? 'badge-orange'
    : s === 'pending'     ? 'badge-yellow'
    : 'badge-grey';
}

function taskBadgeClass(s) {
  return s === 'success' || s === 'simulated' ? 'badge-green'
    : s === 'failed'   ? 'badge-red'
    : s === 'running'  ? 'badge-blue'
    : s === 'retrying' ? 'badge-orange'
    : 'badge-grey';
}

function docBadgeClass(s) {
  return s === 'verified'  ? 'badge-green'
    : s === 'submitted'    ? 'badge-blue'
    : s === 'rejected'     ? 'badge-red'
    : 'badge-grey';
}

function taskIcon(s) {
  return s === 'success' || s === 'simulated' ? '✅'
    : s === 'failed'   ? '❌'
    : s === 'running'  ? '🔄'
    : s === 'retrying' ? '🔁'
    : '⏳';
}

function docIcon(s) {
  return s === 'verified' ? '✅' : s === 'submitted' ? '📎' : '⏳';
}

function formatTaskType(t) {
  return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}