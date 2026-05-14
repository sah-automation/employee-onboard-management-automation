import { supabase }                        from '../config.js';
import { escHtml, showToast, formatDateTime } from '../ui.js';
import { CONFIG }                          from '../config.js';
import { checkSimulationMode } from '../router.js';

let currentUser = null;

// ── Entry point ───────────────────────────────────────────
export async function init(user, container) {
  currentUser = user;

  // Hard block for non-admins
  if (user.role !== CONFIG.roles.ADMIN) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size:2.5rem;">🔒</div>
        <p>Settings are restricted to Admin users only.</p>
      </div>`;
    return;
  }

  container.innerHTML = getShell();
  setupTabs();
  await loadTab('system');
}

export function destroy() {}

// ── Shell ─────────────────────────────────────────────────
function getShell() {
  return `
  <div class="st-layout">
    <div class="tab-bar">
      <button class="tab-btn tab-active" data-tab="system">⚙️ System</button>
      <button class="tab-btn" data-tab="escalation">🔔 Escalation Rules</button>
      <button class="tab-btn" data-tab="roles">👥 Departments & Roles</button>
      <button class="tab-btn" data-tab="integrations">🔗 Integrations</button>
    </div>
    <div id="stTabContent"></div>
  </div>`;
}

// ── Tab switching ─────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b =>
        b.classList.toggle('tab-active', b === btn));
      loadTab(btn.dataset.tab);
    });
  });
}

async function loadTab(tab) {
  const el = document.getElementById('stTabContent');
  el.innerHTML = `<div class="loader-spinner center-spinner"></div>`;
  if      (tab === 'system')      await loadSystemSettings(el);
  else if (tab === 'escalation')  await loadEscalationRules(el);
  else if (tab === 'roles')       await loadDepartmentsRoles(el);
  else if (tab === 'integrations') await loadIntegrations(el);
}

// ══════════════════════════════════════════════════════════
// TAB 1 — System Settings
// ══════════════════════════════════════════════════════════
async function loadSystemSettings(el) {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('*')
      .order('key');
    if (error) throw error;

    el.innerHTML = `
    <div class="st-section">
      <div class="st-section-title">System Settings</div>
      <p class="st-desc">
        These values control global system behaviour.
        Changes take effect immediately on the next workflow execution.
      </p>

      <div class="st-settings-grid" id="settingsGrid">
        ${data.map(s => settingRow(s)).join('')}
      </div>

      <div style="margin-top:16px;">
        <button class="btn-primary" id="saveSettings">💾 Save All Changes</button>
      </div>
    </div>`;

    document.getElementById('saveSettings')
      .addEventListener('click', () => saveSystemSettings(data));

  } catch (e) {
    el.innerHTML = `<p class="err-txt">Failed to load settings: ${escHtml(e.message)}</p>`;
  }
}

function settingRow(s) {
  const isBool = s.value === 'true' || s.value === 'false';
  const isNum  = !isBool && !isNaN(Number(s.value)) && s.value !== '';

  return `
  <div class="st-row">
    <div class="st-row-left">
      <div class="st-key">${escHtml(s.key)}</div>
      <div class="st-desc-small">${escHtml(s.description || '')}</div>
      <div class="st-updated">
        Last updated: ${s.updated_at ? formatDateTime(s.updated_at) : '—'}
        ${s.updated_by ? ` by ${escHtml(s.updated_by)}` : ''}
      </div>
    </div>
    <div class="st-row-right">
      ${isBool ? `
        <label class="toggle-label">
          <input type="checkbox" class="toggle-input setting-input"
            data-key="${escHtml(s.key)}"
            ${s.value === 'true' ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>` :
      `<input type="${isNum ? 'number' : 'text'}"
          class="search-input setting-input"
          style="max-width:200px;"
          data-key="${escHtml(s.key)}"
          value="${escHtml(s.value)}" />`}
    </div>
  </div>`;
}

async function saveSystemSettings(original) {
  const btn = document.getElementById('saveSettings');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const inputs = document.querySelectorAll('.setting-input');
    const updates = [];

    inputs.forEach(input => {
      const key = input.dataset.key;
      const value = input.type === 'checkbox'
        ? (input.checked ? 'true' : 'false')
        : input.value.trim();
      updates.push({ key, value,
        updated_at: new Date().toISOString(),
        updated_by: currentUser.email
      });
    });

    // Upsert all settings
    const { error } = await supabase
      .from('system_settings')
      .upsert(updates, { onConflict: 'key' });

    if (error) throw error;

    showToast('Settings saved successfully', 'success');
    btn.textContent = '✅ Saved';
    setTimeout(() => { btn.disabled = false; btn.textContent = '💾 Save All Changes'; }, 2000);
    await checkSimulationMode();

  } catch (e) {
    showToast(`Save failed: ${e.message}`, 'error');
    btn.disabled = false;
    btn.textContent = '💾 Save All Changes';
  }
}

// ══════════════════════════════════════════════════════════
// TAB 2 — Escalation Rules
// ══════════════════════════════════════════════════════════
async function loadEscalationRules(el) {
  try {
    const { data, error } = await supabase
      .from('escalation_rules')
      .select('*')
      .order('step_type')
      .order('escalation_level');
    if (error) throw error;

    el.innerHTML = `
    <div class="st-section">
      <div class="st-section-title">Escalation Rules</div>
      <p class="st-desc">
        Configure SLA deadlines and escalation targets per approval stage.
        Level 1 fires when SLA expires. Level 2 fires if Level 1 is not resolved.
      </p>

      <div class="esc-rules-grid">
        ${data.map(r => escalationRuleCard(r)).join('')}
      </div>
    </div>`;

    // Wire save buttons
    el.querySelectorAll('.esc-save-btn').forEach(btn =>
      btn.addEventListener('click', () => saveEscalationRule(btn.dataset.id)));

    // Wire toggle buttons
    el.querySelectorAll('.esc-toggle-btn').forEach(btn =>
      btn.addEventListener('click', () =>
        toggleEscalationRule(btn.dataset.id, btn.dataset.active === 'true')));

  } catch (e) {
    el.innerHTML = `<p class="err-txt">Failed to load rules: ${escHtml(e.message)}</p>`;
  }
}

function escalationRuleCard(r) {
  const stepLabel = r.step_type.replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  return `
  <div class="esc-card ${!r.is_active ? 'esc-card-inactive' : ''}">
    <div class="esc-card-header">
      <div>
        <span class="esc-step">${stepLabel}</span>
        <span class="badge ${r.escalation_level === 1 ? 'badge-yellow' : 'badge-red'}">
          Level ${r.escalation_level}
        </span>
      </div>
      <span class="badge ${r.is_active ? 'badge-green' : 'badge-grey'}">
        ${r.is_active ? 'Active' : 'Disabled'}
      </span>
    </div>

    <div class="esc-fields">
      <label class="st-field-label">SLA Hours
        <input type="number" class="search-input esc-field"
          id="sla-${r.id}" value="${r.sla_hours}" min="1" />
      </label>
      <label class="st-field-label">Escalation Target Email
        <input type="email" class="search-input esc-field"
          id="target-${r.id}" value="${escHtml(r.escalation_target)}" />
      </label>
      <label class="st-field-label">Auto-Approve After (hours, blank = never)
        <input type="number" class="search-input esc-field"
          id="auto-${r.id}"
          value="${r.auto_approve_after_hours ?? ''}"
          placeholder="Leave blank to disable" />
      </label>
    </div>

    <div class="esc-card-footer">
      <button class="btn-primary esc-save-btn" data-id="${r.id}">
        💾 Save
      </button>
      <button class="btn-outline esc-toggle-btn"
        data-id="${r.id}" data-active="${r.is_active}">
        ${r.is_active ? '⏸ Disable' : '▶ Enable'}
      </button>
    </div>
  </div>`;
}

async function saveEscalationRule(id) {
  const btn = document.querySelector(`.esc-save-btn[data-id="${id}"]`);
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const sla    = parseInt(document.getElementById(`sla-${id}`).value);
    const target = document.getElementById(`target-${id}`).value.trim();
    const auto   = document.getElementById(`auto-${id}`).value.trim();

    const { error } = await supabase
      .from('escalation_rules')
      .update({
        sla_hours:                sla,
        escalation_target:        target,
        auto_approve_after_hours: auto ? parseInt(auto) : null
      })
      .eq('id', id);

    if (error) throw error;
    showToast('Escalation rule updated', 'success');
    btn.textContent = '✅ Saved';
    setTimeout(() => { btn.disabled = false; btn.textContent = '💾 Save'; }, 2000);

  } catch (e) {
    showToast(`Save failed: ${e.message}`, 'error');
    btn.disabled = false; btn.textContent = '💾 Save';
  }
}

async function toggleEscalationRule(id, currentlyActive) {
  try {
    const { error } = await supabase
      .from('escalation_rules')
      .update({ is_active: !currentlyActive })
      .eq('id', id);
    if (error) throw error;
    showToast(`Rule ${currentlyActive ? 'disabled' : 'enabled'}`, 'success');
    loadTab('escalation');
  } catch (e) {
    showToast(`Toggle failed: ${e.message}`, 'error');
  }
}

// ══════════════════════════════════════════════════════════
// TAB 3 — Departments & Roles
// ══════════════════════════════════════════════════════════
async function loadDepartmentsRoles(el) {
  try {
    const { data: depts, error: e1 } = await supabase
      .from('departments')
      .select('*, roles(id, name, seniority, default_license)')
      .order('name');
    if (e1) throw e1;

    el.innerHTML = `
    <div class="st-section">
      <div class="st-section-title">Departments & Roles</div>
      <p class="st-desc">
        Read-only reference view. To modify departments or roles,
        use the Supabase dashboard directly and re-seed access packages.
      </p>

      <div class="dept-grid">
        ${depts.map(d => `
        <div class="dept-card">
          <div class="dept-header">
            <div>
              <span class="dept-name">${escHtml(d.name)}</span>
              <span class="dept-code">${escHtml(d.code)}</span>
            </div>
            <span class="badge badge-blue">${d.roles?.length || 0} roles</span>
          </div>

          <div class="dept-meta">
            <span>Head: ${escHtml(d.head_email || '—')}</span>
          </div>

          ${d.roles?.length ? `
          <div class="dept-roles">
            ${d.roles.map(r => `
              <div class="dept-role-row">
                <span class="dept-role-name">${escHtml(r.name)}</span>
                <span class="emp-email">${escHtml(r.seniority || '')}</span>
                <span class="sim-tag">${escHtml(r.default_license || '—')}</span>
              </div>`).join('')}
          </div>` : `
          <p class="empty-txt" style="padding:10px 0 0;">No roles defined.</p>`}

          ${d.default_channels?.length ? `
          <div class="dept-channels">
            ${d.default_channels.map(c =>
              `<span class="channel-tag">${escHtml(c)}</span>`).join('')}
          </div>` : ''}
        </div>`).join('')}
      </div>
    </div>`;

  } catch (e) {
    el.innerHTML =
      `<p class="err-txt">Failed to load departments: ${escHtml(e.message)}</p>`;
  }
}

// ══════════════════════════════════════════════════════════
// TAB 4 — Integrations
// ══════════════════════════════════════════════════════════
async function loadIntegrations(el) {
  try {
    const { data: runs, error } = await supabase
      .from('integration_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(20);
    if (error) throw error;

    // Latest per type
    const latest = {};
    runs.forEach(r => { if (!latest[r.run_type]) latest[r.run_type] = r; });

    el.innerHTML = `
    <div class="st-section">
      <div class="st-section-title">Integration Health</div>
      <p class="st-desc">
        Last run status for each integration type.
        These are automatically tracked by n8n workflows.
      </p>

      <div class="int-grid">
        ${Object.entries(latest).map(([type, run]) => `
        <div class="int-card">
          <div class="int-card-top">
            <span class="int-type">${formatRunType(type)}</span>
            <span class="badge ${
              run.status === 'success' ? 'badge-green'  :
              run.status === 'running' ? 'badge-blue'   :
              run.status === 'partial' ? 'badge-yellow' : 'badge-red'
            }">${run.status}</span>
          </div>
          <div class="int-stats">
            <div>
              <div class="st-desc-small">Processed</div>
              <strong>${run.records_processed ?? 0}</strong>
            </div>
            <div>
              <div class="st-desc-small">Failed</div>
              <strong class="${run.records_failed > 0 ? 'err-txt' : ''}">
                ${run.records_failed ?? 0}
              </strong>
            </div>
            <div>
              <div class="st-desc-small">Last Run</div>
              <strong>${run.completed_at
                ? formatDateTime(run.completed_at) : '—'}</strong>
            </div>
          </div>
          ${run.error_message ? `
          <div class="int-error">⚠️ ${escHtml(run.error_message)}</div>` : ''}
        </div>`).join('')}
      </div>

      <div class="st-section-title" style="margin-top:24px;">
        Recent Run History
      </div>
      <div class="panel" style="margin-top:10px;">
        <table class="req-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Status</th>
              <th>Processed</th>
              <th>Failed</th>
              <th>Started</th>
              <th>Completed</th>
            </tr>
          </thead>
          <tbody>
            ${runs.map(r => `
            <tr>
              <td><span class="task-type-label">${formatRunType(r.run_type)}</span></td>
              <td><span class="badge ${
                r.status === 'success' ? 'badge-green'  :
                r.status === 'running' ? 'badge-blue'   :
                r.status === 'partial' ? 'badge-yellow' : 'badge-red'
              }">${r.status}</span></td>
              <td>${r.records_processed ?? 0}</td>
              <td class="${r.records_failed > 0 ? 'err-txt' : ''}">
                ${r.records_failed ?? 0}
              </td>
              <td>${r.started_at   ? formatDateTime(r.started_at)   : '—'}</td>
              <td>${r.completed_at ? formatDateTime(r.completed_at) : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  } catch (e) {
    el.innerHTML =
      `<p class="err-txt">Failed to load integrations: ${escHtml(e.message)}</p>`;
  }
}

// ── Helpers ───────────────────────────────────────────────
function formatRunType(type) {
  return (type || '').replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}