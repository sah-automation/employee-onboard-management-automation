import { supabase }                                     from '../config.js';
import { statusBadge, formatDateTime, timeAgo,
         escHtml, showToast }                           from '../ui.js';
import { CONFIG }                                       from '../config.js';

let currentUser = null;
let realtimeSub = null;
let activeTab   = 'hr';

// ── Entry point ───────────────────────────────────────────
export async function init(user, container) {
  currentUser = user;
  activeTab   = defaultTab(user);
  container.innerHTML = getShell(user);

  setupTabs();
  await loadTab(activeTab);
  updatePendingBadge();
  subscribeRealtime();
}

export function destroy() {
  if (realtimeSub) { supabase.removeChannel(realtimeSub); realtimeSub = null; }
}

// ── Which tab to show first based on role ─────────────────
function defaultTab(user) {
  if (user.role === CONFIG.roles.IT)      return 'it';
  if (user.role === CONFIG.roles.MANAGER) return 'mgr';
  return 'hr';
}

// ── Page shell ────────────────────────────────────────────
function getShell(user) {
  const isAdmin = user.role === CONFIG.roles.ADMIN;
  const isHR    = user.role === CONFIG.roles.HR    || isAdmin;
  const isIT    = user.role === CONFIG.roles.IT    || isAdmin;
  const isMgr   = user.role === CONFIG.roles.MANAGER || isAdmin;

  return `
  <div class="ap-layout">

    <!-- Tab bar -->
    <div class="tab-bar">
      ${isHR  ? `<button class="tab-btn" data-tab="hr">
                   HR Approvals
                   <span class="tab-count" id="hrCount"></span>
                 </button>` : ''}
      ${isIT  ? `<button class="tab-btn" data-tab="it">
                   IT Approvals
                   <span class="tab-count" id="itCount"></span>
                 </button>` : ''}
      ${isMgr ? `<button class="tab-btn" data-tab="mgr">
                   Manager Approvals
                   <span class="tab-count" id="mgrCount"></span>
                 </button>` : ''}
      <div class="tab-spacer"></div>
      <button class="btn-outline" id="refreshApprovals">↻ Refresh</button>
    </div>

    <!-- Escalation alerts -->
    <div id="escalationAlerts"></div>

    <!-- Tab content -->
    <div id="tabContent">
      <div class="loader-spinner center-spinner"></div>
    </div>

  </div>`;
}

// ── Tab switching ─────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b =>
        b.classList.toggle('tab-active', b.dataset.tab === activeTab));
      await loadTab(activeTab);
    });
  });

  // Set initial active
  const initial = document.querySelector(`.tab-btn[data-tab="${activeTab}"]`);
  if (initial) initial.classList.add('tab-active');

  // Refresh button
  document.getElementById('refreshApprovals')
    ?.addEventListener('click', () => loadTab(activeTab));
}

// ── Load tab content ──────────────────────────────────────
async function loadTab(tab) {
  const stepType = tab === 'hr' ? 'hr_approval'
                 : tab === 'it' ? 'it_approval'
                 : 'mgr_approval';

  const container = document.getElementById('tabContent');
  container.innerHTML = `<div class="loader-spinner center-spinner"></div>`;

  try {
    // Build query
    let query = supabase
      .from('approval_steps')
      .select(`
        id, step_type, status, assignee_email, assignee_name,
        due_at, responded_at, response_action, response_note,
        created_at, teams_message_id, request_id,
        onboarding_requests (
          id, request_code, status, is_simulation,
          employees (
            first_name, last_name, personal_email,
            job_title, work_mode, start_date,
            departments ( name )
          ),
          roles ( name ),
          role_access_packages ( package_name )
        )
      `)
      .eq('step_type', stepType)
      .order('created_at', { ascending: false });

    // Managers only see their department
    if (currentUser.role === CONFIG.roles.MANAGER && currentUser.department) {
      // Filter steps where employee's department matches
      query = query.eq(
        'onboarding_requests.employees.department_id',
        currentUser.department
      );
    }

    // Non-admin HR only sees own assignments
    if (currentUser.role === CONFIG.roles.HR) {
      query = query.eq('assignee_email', currentUser.email);
    }

    // Non-admin IT only sees own assignments
    if (currentUser.role === CONFIG.roles.IT) {
      query = query.eq('assignee_email', currentUser.email);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Update tab count badge
    const pending = data.filter(s => s.status === 'pending').length;
    const countEl = document.getElementById(`${tab}Count`);
    if (countEl) {
      countEl.textContent = pending || '';
    }

    renderApprovalCards(data, container);
    await loadEscalationAlerts(stepType);

  } catch (e) {
    container.innerHTML =
      `<p class="err-txt">Failed to load approvals: ${escHtml(e.message)}</p>`;
  }
}

// ── Render approval cards ─────────────────────────────────
function renderApprovalCards(steps, container) {
  if (!steps.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size:2.5rem;">✅</div>
        <p>No approval requests found.</p>
      </div>`;
    return;
  }

  // Group: pending first, then rest
  const pending  = steps.filter(s => s.status === 'pending');
  const rest     = steps.filter(s => s.status !== 'pending');

  container.innerHTML = `
    ${pending.length ? `
      <div class="ap-section-title">
        Awaiting Response
        <span class="ap-count">${pending.length}</span>
      </div>
      <div class="ap-cards">
        ${pending.map(s => approvalCard(s, true)).join('')}
      </div>` : ''}

    ${rest.length ? `
      <div class="ap-section-title" style="margin-top:20px;">
        Completed / History
        <span class="ap-count">${rest.length}</span>
      </div>
      <div class="ap-cards">
        ${rest.map(s => approvalCard(s, false)).join('')}
      </div>` : ''}
  `;

  // Wire up approve/reject buttons
  container.querySelectorAll('.ap-approve').forEach(btn =>
    btn.addEventListener('click', () => handleAction(btn.dataset.stepId, 'approved')));
  container.querySelectorAll('.ap-reject').forEach(btn =>
    btn.addEventListener('click', () => handleAction(btn.dataset.stepId, 'rejected')));
}

// ── Build one approval card ───────────────────────────────
function approvalCard(step, isPending) {
  const req  = step.onboarding_requests;
  const emp  = req?.employees;
  const due  = new Date(step.due_at);
  const now  = new Date();
  const isOverdue = due < now && isPending;
  const hoursLeft = Math.round((due - now) / (1000 * 60 * 60));

  return `
  <div class="ap-card ${isPending ? 'ap-card-pending' : ''} ${isOverdue ? 'ap-card-overdue' : ''}">
    <div class="ap-card-top">
      <div class="ap-card-left">
        <div class="ap-name">
          ${escHtml(emp?.first_name || '')} ${escHtml(emp?.last_name || '')}
          ${req?.is_simulation ? `<span class="sim-tag">SIM</span>` : ''}
        </div>
        <div class="ap-sub">
          ${escHtml(emp?.job_title || '')} ·
          ${escHtml(emp?.departments?.name || '')} ·
          ${escHtml(emp?.work_mode || '')}
        </div>
      </div>
      <div class="ap-card-right">
        ${statusBadge(step.status)}
      </div>
    </div>

    <div class="ap-facts">
      <div class="ap-fact">
        <span class="ap-fact-lbl">Request</span>
        <span class="ap-fact-val">${escHtml(req?.request_code || '—')}</span>
      </div>
      <div class="ap-fact">
        <span class="ap-fact-lbl">Start Date</span>
        <span class="ap-fact-val">${emp?.start_date || '—'}</span>
      </div>
      <div class="ap-fact">
        <span class="ap-fact-lbl">Access Package</span>
        <span class="ap-fact-val">
          ${escHtml(req?.role_access_packages?.package_name || req?.roles?.name || '—')}
        </span>
      </div>
      <div class="ap-fact">
        <span class="ap-fact-lbl">Submitted</span>
        <span class="ap-fact-val">${timeAgo(step.created_at)}</span>
      </div>
      <div class="ap-fact">
        <span class="ap-fact-lbl">Assigned To</span>
        <span class="ap-fact-val">${escHtml(step.assignee_email)}</span>
      </div>
      <div class="ap-fact">
        <span class="ap-fact-lbl">SLA Deadline</span>
        <span class="ap-fact-val ${isOverdue ? 'overdue-txt' : ''}">
          ${formatDateTime(step.due_at)}
          ${isPending ? `(${isOverdue
            ? `<strong>overdue by ${Math.abs(hoursLeft)}h</strong>`
            : `${hoursLeft}h remaining`})` : ''}
        </span>
      </div>
      ${step.response_note ? `
      <div class="ap-fact ap-fact-full">
        <span class="ap-fact-lbl">Note</span>
        <span class="ap-fact-val">${escHtml(step.response_note)}</span>
      </div>` : ''}
    </div>

    ${isPending ? `
    <div class="ap-actions">
      <div class="ap-note-wrap">
        <input type="text" class="ap-note-input" id="note-${step.id}"
          placeholder="Optional note (required for rejection)" />
      </div>
      <div class="ap-btns">
        <button class="ap-approve btn-approve"
          data-step-id="${step.id}">✅ Approve</button>
        <button class="ap-reject btn-reject"
          data-step-id="${step.id}">❌ Reject</button>
      </div>
    </div>` : `
    <div class="ap-responded">
      ${step.response_action === 'approved'
        ? `<span class="resp-approved">✅ Approved</span>`
        : step.response_action === 'rejected'
        ? `<span class="resp-rejected">❌ Rejected</span>`
        : `<span class="resp-other">${escHtml(step.status)}</span>`}
      ${step.responded_at
        ? `<span class="resp-time">${formatDateTime(step.responded_at)}</span>` : ''}
    </div>`}
  </div>`;
}

// ── Handle approve / reject from dashboard ────────────────
async function handleAction(stepId, action) {
  const noteEl = document.getElementById(`note-${stepId}`);
  const note   = noteEl?.value?.trim() || '';

  if (action === 'rejected' && !note) {
    showToast('Please enter a rejection reason before rejecting.', 'warning');
    noteEl?.focus();
    return;
  }

  const btn = document.querySelector(
    `.${action === 'approved' ? 'ap-approve' : 'ap-reject'}[data-step-id="${stepId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }

  try {
    // Fetch the step to get its token
    const { data: step, error: e1 } = await supabase
      .from('approval_steps')
      .select('id, request_id')
      .eq('id', stepId)
      .single();
    if (e1) throw e1;

    // Fetch valid token for this step
    const { data: tokens, error: e2 } = await supabase
      .from('approval_tokens')
      .select('id, token')
      .eq('step_id', stepId)
      .eq('used', false)
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    if (e2) throw e2;

    if (!tokens || tokens.length === 0) {
      throw new Error('No valid approval token found for this step. It may have expired or been used already.');
    }

    // Call the n8n approval response webhook
    const { value: n8nBase } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'n8n_base_url')
      .single()
      .then(r => r.data || { value: '' });

    const webhookUrl =
      `${n8nBase}/webhook/approval-response?token_id=${tokens[0].id}&action=${action}`;

    const resp = await fetch(webhookUrl, {
      method:  'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Webhook returned ${resp.status}: ${text}`);
    }

    // Also update the note if provided
    if (note) {
      await supabase
        .from('approval_steps')
        .update({ response_note: note })
        .eq('id', stepId);
    }

    showToast(
      action === 'approved' ? '✅ Request approved successfully' : '❌ Request rejected',
      action === 'approved' ? 'success' : 'warning'
    );

    // Reload tab after short delay
    setTimeout(() => loadTab(activeTab), 1000);

  } catch (e) {
    showToast(`Action failed: ${e.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = action === 'approved' ? '✅ Approve' : '❌ Reject';
    }
  }
}

// ── Load escalation alerts ────────────────────────────────
async function loadEscalationAlerts(stepType) {
  try {
    const { data } = await supabase
      .from('escalation_events')
      .select(`
        id, escalation_level, escalated_to,
        reason, created_at, resolved,
        approval_steps ( step_type, assignee_email,
          onboarding_requests (
            request_code,
            employees ( first_name, last_name )
          )
        )
      `)
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(10);

    const el = document.getElementById('escalationAlerts');
    if (!data?.length) { el.innerHTML = ''; return; }

    el.innerHTML = `
      <div class="escalation-banner">
        <strong>⚠️ Active Escalations (${data.length})</strong>
        <div class="esc-list">
          ${data.map(ev => {
            const req  = ev.approval_steps?.onboarding_requests;
            const emp  = req?.employees;
            return `
            <div class="esc-item">
              <span class="esc-code">${escHtml(req?.request_code || '—')}</span>
              <span class="esc-name">
                ${escHtml(emp?.first_name || '')} ${escHtml(emp?.last_name || '')}
              </span>
              <span class="esc-reason">${escHtml(ev.reason)}</span>
              <span class="esc-time">${timeAgo(ev.created_at)}</span>
              <button class="esc-resolve btn-outline"
                data-esc-id="${ev.id}">Mark Resolved</button>
            </div>`;
          }).join('')}
        </div>
      </div>`;

    // Wire resolve buttons
    el.querySelectorAll('.esc-resolve').forEach(btn =>
      btn.addEventListener('click', () => resolveEscalation(btn.dataset.escId)));

  } catch (e) {
    console.warn('Could not load escalations:', e.message);
  }
}

// ── Resolve escalation ────────────────────────────────────
async function resolveEscalation(escId) {
  try {
    const { error } = await supabase
      .from('escalation_events')
      .update({
        resolved:    true,
        resolved_at: new Date().toISOString(),
        resolved_by: currentUser.email
      })
      .eq('id', escId);

    if (error) throw error;
    showToast('Escalation marked as resolved', 'success');
    loadTab(activeTab);
  } catch (e) {
    showToast(`Failed to resolve: ${e.message}`, 'error');
  }
}

// ── Update pending badge in sidebar nav ──────────────────
async function updatePendingBadge() {
  try {
    const { count } = await supabase
      .from('approval_steps')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');

    const badge = document.getElementById('pendingCount');
    if (badge) badge.textContent = count > 0 ? count : '';
  } catch (e) { /* silent */ }
}

// ── Real-time ─────────────────────────────────────────────
function subscribeRealtime() {
  realtimeSub = supabase
    .channel('approvals_page')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'approval_steps' },
      () => { loadTab(activeTab); updatePendingBadge(); })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'escalation_events' },
      () => loadTab(activeTab))
    .subscribe();
}