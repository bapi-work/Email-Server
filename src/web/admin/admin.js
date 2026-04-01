'use strict';

const API = '/api';
let token = localStorage.getItem('cm_admin_token');

// ─── Utility ────────────────────────────────────────────────────────────────

function showSpinner(v) { document.getElementById('spinner').style.display = v ? 'flex' : 'none'; }
function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `alert alert-${type} position-fixed top-0 end-0 m-3 shadow`;
  t.style.cssText = 'z-index:9999;min-width:260px';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { logout(); return null; }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

function statusBadge(active) {
  return active
    ? '<span class="badge badge-status-active">Active</span>'
    : '<span class="badge badge-status-inactive">Inactive</span>';
}

// ─── Auth ────────────────────────────────────────────────────────────────────

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  errEl.classList.add('d-none');
  showSpinner(true);
  try {
    const data = await apiFetch('/auth/admin/login', { method: 'POST', body: { email, password } });
    if (data?.token) {
      token = data.token;
      localStorage.setItem('cm_admin_token', token);
      document.getElementById('admin-name').textContent = data.user.email;
      showApp();
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('d-none');
  } finally {
    showSpinner(false);
  }
});

function logout() {
  token = null;
  localStorage.removeItem('cm_admin_token');
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await apiFetch('/auth/admin/logout', { method: 'POST' }).catch(() => {});
  logout();
});

// ─── Navigation ──────────────────────────────────────────────────────────────

function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#sidebar .nav-link').forEach(l => l.classList.remove('active'));
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');
  const link = document.querySelector(`[data-page="${page}"]`);
  if (link) link.classList.add('active');
  const titles = { dashboard: 'Dashboard', domains: 'Domains', mailboxes: 'Mailboxes', aliases: 'Aliases', campaigns: 'Campaigns', 'smtp-logs': 'SMTP Logs', 'dns-wizard': 'DNS Wizard', blocklist: 'Blocklist', settings: 'Settings' };
  document.getElementById('page-title').textContent = titles[page] || page;
  loadPage(page);
}

document.querySelectorAll('#sidebar .nav-link').forEach(link => {
  link.addEventListener('click', e => { e.preventDefault(); navigate(link.dataset.page); });
});

// ─── Page Loaders ────────────────────────────────────────────────────────────

async function loadPage(page) {
  showSpinner(true);
  try {
    switch (page) {
      case 'dashboard':   await loadDashboard(); break;
      case 'domains':     await loadDomains(); break;
      case 'mailboxes':   await loadMailboxes(); break;
      case 'aliases':     await loadAliases(); break;
      case 'campaigns':   await loadCampaigns(); break;
      case 'smtp-logs':   await loadSmtpLogs(); break;
      case 'dns-wizard':  await loadDnsWizard(); break;
      case 'blocklist':   await loadBlocklist(); break;
      case 'settings':    await loadSettings(); break;
    }
  } catch (err) {
    toast(err.message, 'danger');
  } finally {
    showSpinner(false);
  }
}

// Dashboard
async function loadDashboard() {
  const stats = await apiFetch('/settings/stats');
  if (!stats) return;
  document.getElementById('stat-domains').textContent   = stats.domains;
  document.getElementById('stat-mailboxes').textContent = stats.mailboxes;
  document.getElementById('stat-messages').textContent  = stats.messages;
  document.getElementById('stat-campaigns').textContent = stats.campaigns;

  const smtp = stats.smtp24h || {};
  document.getElementById('smtp-stats-chart').innerHTML = `
    <div class="row text-center g-2">
      ${Object.entries(smtp).map(([k, v]) => `<div class="col"><div class="fw-bold">${v}</div><div class="text-muted small text-capitalize">${k}</div></div>`).join('') || '<div class="text-muted">No SMTP activity in last 24h</div>'}
    </div>`;
}

// Domains
async function loadDomains() {
  const data = await apiFetch('/domains');
  if (!data) return;
  const tbody = document.getElementById('domains-tbody');
  tbody.innerHTML = data.domains.map(d => `
    <tr>
      <td><strong>${d.name}</strong><br><small class="text-muted">${d.description || ''}</small></td>
      <td>${d.dkim_enabled ? '<i class="bi bi-check-circle-fill text-success"></i>' : '<i class="bi bi-x-circle text-muted"></i>'}</td>
      <td><span class="badge bg-light text-dark">${d.dmarc_policy || 'none'}</span></td>
      <td>—</td>
      <td>${statusBadge(d.active)}</td>
      <td>
        <button class="btn btn-sm btn-outline-info me-1" onclick="generateDkim('${d.id}')">DKIM</button>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteDomain('${d.id}', '${d.name}')">Delete</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="text-center text-muted py-4">No domains found</td></tr>';
}

// Mailboxes
async function loadMailboxes() {
  const data = await apiFetch('/mailboxes');
  if (!data) return;
  const tbody = document.getElementById('mailboxes-tbody');
  tbody.innerHTML = data.mailboxes.map(m => `
    <tr>
      <td><strong>${m.username}@${m.domain_name}</strong></td>
      <td>${m.full_name || '—'}</td>
      <td>${m.quota_mb} MB</td>
      <td>
        ${m.can_send ? '<i class="bi bi-arrow-up-circle text-success" title="Send"></i>' : '<i class="bi bi-arrow-up-circle text-muted"></i>'}
        ${m.can_receive ? '<i class="bi bi-arrow-down-circle text-success ms-1" title="Receive"></i>' : '<i class="bi bi-arrow-down-circle text-muted ms-1"></i>'}
      </td>
      <td>${statusBadge(m.active)}</td>
      <td>
        <button class="btn btn-sm btn-outline-warning me-1" onclick="toggleMailbox('${m.id}', ${!m.active})">${m.active ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteMailbox('${m.id}')">Delete</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="text-center text-muted py-4">No mailboxes</td></tr>';
}

// Aliases
async function loadAliases() {
  const data = await apiFetch('/aliases');
  if (!data) return;
  const tbody = document.getElementById('aliases-tbody');
  tbody.innerHTML = data.data.map(a => `
    <tr>
      <td>${a.source_local}@${a.domain_name}</td>
      <td>${a.destination}</td>
      <td>${a.domain_name}</td>
      <td>${statusBadge(a.active)}</td>
      <td><button class="btn btn-sm btn-outline-danger" onclick="deleteAlias('${a.id}')">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="text-center text-muted py-4">No aliases</td></tr>';
}

// Campaigns
async function loadCampaigns() {
  const data = await apiFetch('/campaigns');
  if (!data) return;
  const statusColor = { draft:'secondary', scheduled:'info', sending:'primary', paused:'warning', completed:'success', cancelled:'danger' };
  const tbody = document.getElementById('campaigns-tbody');
  tbody.innerHTML = data.data.map(c => `
    <tr>
      <td><strong>${c.name}</strong></td>
      <td>${c.from_address}</td>
      <td><span class="badge bg-${statusColor[c.status]||'secondary'}">${c.status}</span></td>
      <td>${c.total_recipients}</td>
      <td>${c.sent_count}</td>
      <td>${c.opened_count}</td>
      <td>
        ${c.status === 'draft' ? `<button class="btn btn-sm btn-success me-1" onclick="sendCampaign('${c.id}')">Send</button>` : ''}
        ${c.status === 'sending' ? `<button class="btn btn-sm btn-warning me-1" onclick="pauseCampaign('${c.id}')">Pause</button>` : ''}
        <button class="btn btn-sm btn-outline-danger" onclick="deleteCampaign('${c.id}')">Delete</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" class="text-center text-muted py-4">No campaigns</td></tr>';
}

// SMTP Logs
async function loadSmtpLogs() {
  const data = await apiFetch('/messages/logs/smtp?limit=200');
  if (!data) return;
  const statusColor = { accepted:'success', rejected:'danger', deferred:'warning', delivered:'info', bounced:'danger' };
  const tbody = document.getElementById('smtp-logs-tbody');
  tbody.innerHTML = data.data.map(l => `
    <tr>
      <td class="text-nowrap small">${fmtDate(l.logged_at)}</td>
      <td><span class="badge bg-${l.direction==='inbound'?'info':'primary'}">${l.direction}</span></td>
      <td class="small">${l.from_address || '—'}</td>
      <td class="small">${l.to_address || '—'}</td>
      <td class="small">${l.client_ip || '—'}</td>
      <td><span class="badge bg-${statusColor[l.status]||'secondary'}">${l.status}</span></td>
      <td><small>${l.spf_result || '—'}</small></td>
      <td><small>${l.dkim_result || '—'}</small></td>
    </tr>`).join('') || '<tr><td colspan="8" class="text-center text-muted py-4">No logs</td></tr>';
}

// DNS Wizard
async function loadDnsWizard() {
  const data = await apiFetch('/domains');
  if (!data) return;
  const select = document.getElementById('dns-domain-select');
  select.innerHTML = '<option value="">-- choose domain --</option>' +
    data.domains.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
}

document.getElementById('dns-load-btn').addEventListener('click', async () => {
  const domainId = document.getElementById('dns-domain-select').value;
  if (!domainId) return toast('Select a domain', 'warning');
  showSpinner(true);
  try {
    const data = await apiFetch(`/settings/dns/${domainId}`);
    if (!data) return;
    const cont = document.getElementById('dns-records-container');
    cont.innerHTML = Object.values(data.records).map(r => `
      <div class="table-card p-3 mb-3">
        <div class="d-flex justify-content-between align-items-start mb-1">
          <span class="badge bg-primary">${r.type}</span>
          <small class="text-muted">${r.description}</small>
        </div>
        <div class="row g-2 mt-1">
          <div class="col-md-4"><label class="form-label small fw-semibold">Host / Name</label><input class="form-control form-control-sm font-monospace" readonly value="${r.host || ''}"/></div>
          <div class="col-md-6"><label class="form-label small fw-semibold">Value</label><input class="form-control form-control-sm font-monospace" readonly value="${r.value || ''}"/></div>
          ${r.priority !== undefined ? `<div class="col-md-2"><label class="form-label small fw-semibold">Priority</label><input class="form-control form-control-sm" readonly value="${r.priority}"/></div>` : ''}
        </div>
        ${r.ttl ? `<div class="mt-1 text-muted small">TTL: ${r.ttl}s</div>` : ''}
      </div>`).join('');
  } catch (err) {
    toast(err.message, 'danger');
  } finally {
    showSpinner(false);
  }
});

// Blocklist
async function loadBlocklist() {
  const data = await apiFetch('/settings/blocklist');
  if (!data) return;
  const tbody = document.getElementById('blocklist-tbody');
  tbody.innerHTML = data.data.map(b => `
    <tr>
      <td><span class="badge bg-secondary">${b.type}</span></td>
      <td><code>${b.value}</code></td>
      <td>${b.reason || '—'}</td>
      <td class="small">${fmtDate(b.created_at)}</td>
      <td><button class="btn btn-sm btn-outline-danger" onclick="removeBlock('${b.id}')">Remove</button></td>
    </tr>`).join('');
}

// Settings
async function loadSettings() {
  const data = await apiFetch('/settings/admin-users');
  if (!data) return;
  document.getElementById('admin-users-list').innerHTML = data.map(u => `
    <div class="d-flex justify-content-between align-items-center border-bottom py-2">
      <div><strong>${u.full_name || u.email}</strong><br><small class="text-muted">${u.email} &middot; ${u.role}</small></div>
      ${statusBadge(u.active)}
    </div>`).join('');
}

// ─── Action Handlers ─────────────────────────────────────────────────────────

async function generateDkim(domainId) {
  if (!confirm('Generate new DKIM key pair? This will replace any existing keys.')) return;
  showSpinner(true);
  try {
    const data = await apiFetch(`/settings/dkim/generate/${domainId}`, { method: 'POST' });
    toast('DKIM keys generated! Update your DNS record.');
    await loadDomains();
  } catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
}

async function deleteDomain(id, name) {
  if (!confirm(`Delete domain ${name}? This will also delete all mailboxes and messages!`)) return;
  showSpinner(true);
  try { await apiFetch(`/domains/${id}`, { method: 'DELETE' }); toast('Domain deleted'); await loadDomains(); }
  catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
}

async function toggleMailbox(id, active) {
  showSpinner(true);
  try { await apiFetch(`/mailboxes/${id}`, { method: 'PUT', body: { active } }); await loadMailboxes(); }
  catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
}

async function deleteMailbox(id) {
  if (!confirm('Delete this mailbox and all its messages?')) return;
  showSpinner(true);
  try { await apiFetch(`/mailboxes/${id}`, { method: 'DELETE' }); toast('Mailbox deleted'); await loadMailboxes(); }
  catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
}

async function deleteAlias(id) {
  if (!confirm('Delete this alias?')) return;
  await apiFetch(`/aliases/${id}`, { method: 'DELETE' });
  await loadAliases();
}

async function sendCampaign(id) {
  if (!confirm('Start sending this campaign? This cannot be undone.')) return;
  showSpinner(true);
  try { const d = await apiFetch(`/campaigns/${id}/send`, { method: 'POST' }); toast(`Campaign started — ${d.queued} emails queued`); await loadCampaigns(); }
  catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
}

async function pauseCampaign(id) {
  await apiFetch(`/campaigns/${id}/pause`, { method: 'POST' });
  toast('Campaign paused');
  await loadCampaigns();
}

async function deleteCampaign(id) {
  if (!confirm('Delete this campaign?')) return;
  try { await apiFetch(`/campaigns/${id}`, { method: 'DELETE' }); toast('Campaign deleted'); await loadCampaigns(); }
  catch (err) { toast(err.message, 'danger'); }
}

async function removeBlock(id) {
  await apiFetch(`/settings/blocklist/${id}`, { method: 'DELETE' });
  await loadBlocklist();
}

// ─── Save Handlers ───────────────────────────────────────────────────────────

document.getElementById('save-domain-btn').addEventListener('click', async () => {
  const name  = document.getElementById('new-domain-name').value.trim().toLowerCase();
  const desc  = document.getElementById('new-domain-desc').value;
  const quota = parseInt(document.getElementById('new-domain-quota').value);
  const dkim  = document.getElementById('new-domain-dkim').checked;
  if (!name) return toast('Domain name required', 'warning');
  showSpinner(true);
  try {
    const created = await apiFetch('/domains', { method: 'POST', body: { name, description: desc, default_quota_mb: quota } });
    if (dkim && created?.id) await apiFetch(`/settings/dkim/generate/${created.id}`, { method: 'POST' }).catch(() => {});
    bootstrap.Modal.getInstance(document.getElementById('domainModal')).hide();
    toast('Domain added!');
    await loadDomains();
  } catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
});

document.getElementById('save-mailbox-btn').addEventListener('click', async () => {
  const domain_id = document.getElementById('new-mb-domain').value;
  const username  = document.getElementById('new-mb-username').value.trim().toLowerCase();
  const full_name = document.getElementById('new-mb-name').value;
  const password  = document.getElementById('new-mb-password').value;
  const quota_mb  = parseInt(document.getElementById('new-mb-quota').value);
  if (!domain_id || !username || !password) return toast('Domain, username, and password required', 'warning');
  showSpinner(true);
  try {
    await apiFetch('/mailboxes', { method: 'POST', body: { domain_id, username, full_name, password, quota_mb } });
    bootstrap.Modal.getInstance(document.getElementById('mailboxModal')).hide();
    toast('Mailbox created!');
    await loadMailboxes();
  } catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
});

document.getElementById('save-alias-btn').addEventListener('click', async () => {
  const domain_id    = document.getElementById('new-alias-domain').value;
  const source_local = document.getElementById('new-alias-source').value.trim().toLowerCase();
  const destination  = document.getElementById('new-alias-dest').value.trim().toLowerCase();
  if (!domain_id || !source_local || !destination) return toast('All fields required', 'warning');
  showSpinner(true);
  try {
    await apiFetch('/aliases', { method: 'POST', body: { domain_id, source_local, destination } });
    bootstrap.Modal.getInstance(document.getElementById('aliasModal')).hide();
    toast('Alias created!');
    await loadAliases();
  } catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
});

document.getElementById('save-campaign-btn').addEventListener('click', async () => {
  const body = {
    name:         document.getElementById('new-camp-name').value,
    from_name:    document.getElementById('new-camp-fromname').value,
    from_address: document.getElementById('new-camp-from').value,
    reply_to:     document.getElementById('new-camp-replyto').value || undefined,
    subject:      document.getElementById('new-camp-subject').value,
    body_html:    document.getElementById('new-camp-html').value,
    body_text:    document.getElementById('new-camp-text').value,
  };
  if (!body.name || !body.from_address || !body.subject) return toast('Name, from, and subject required', 'warning');
  showSpinner(true);
  try {
    await apiFetch('/campaigns', { method: 'POST', body });
    bootstrap.Modal.getInstance(document.getElementById('campaignModal')).hide();
    toast('Campaign created!');
    await loadCampaigns();
  } catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
});

document.getElementById('save-block-btn').addEventListener('click', async () => {
  const type   = document.getElementById('new-block-type').value;
  const value  = document.getElementById('new-block-value').value.trim();
  const reason = document.getElementById('new-block-reason').value;
  if (!value) return toast('Value required', 'warning');
  showSpinner(true);
  try {
    await apiFetch('/settings/blocklist', { method: 'POST', body: { type, value, reason } });
    bootstrap.Modal.getInstance(document.getElementById('blocklistModal')).hide();
    toast('Entry blocked');
    await loadBlocklist();
  } catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
});

document.getElementById('save-admin-user-btn').addEventListener('click', async () => {
  const body = {
    email:     document.getElementById('new-admin-email').value,
    full_name: document.getElementById('new-admin-name').value,
    password:  document.getElementById('new-admin-pass').value,
    role:      document.getElementById('new-admin-role').value,
  };
  if (!body.email || !body.password) return toast('Email and password required', 'warning');
  showSpinner(true);
  try {
    await apiFetch('/settings/admin-users', { method: 'POST', body });
    bootstrap.Modal.getInstance(document.getElementById('adminUserModal')).hide();
    toast('Admin user created!');
    await loadSettings();
  } catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
});

document.getElementById('change-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const currentPassword = document.getElementById('cp-current').value;
  const newPassword     = document.getElementById('cp-new').value;
  const confirmPassword = document.getElementById('cp-confirm').value;
  if (newPassword !== confirmPassword) return toast('Passwords do not match', 'warning');
  showSpinner(true);
  try {
    await apiFetch('/auth/admin/password', { method: 'PUT', body: { currentPassword, newPassword } });
    toast('Password updated!');
    document.getElementById('change-password-form').reset();
  } catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
});

// ─── Domain/Mailbox selects for modals ───────────────────────────────────────

async function populateDomainSelects() {
  const data = await apiFetch('/domains');
  if (!data) return;
  const options = data.domains.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  document.getElementById('new-mb-domain').innerHTML = options;
  document.getElementById('new-alias-domain').innerHTML = options;
}

document.getElementById('domainModal').addEventListener('show.bs.modal', () => {});
document.getElementById('mailboxModal').addEventListener('show.bs.modal', populateDomainSelects);
document.getElementById('aliasModal').addEventListener('show.bs.modal', populateDomainSelects);

// ─── Startup ─────────────────────────────────────────────────────────────────

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  navigate('dashboard');
}

// Check for saved token on load
(async () => {
  if (token) {
    try {
      const me = await apiFetch('/auth/admin/me');
      if (me) {
        document.getElementById('admin-name').textContent = me.email;
        showApp();
        return;
      }
    } catch {}
    token = null;
    localStorage.removeItem('cm_admin_token');
  }
})();
