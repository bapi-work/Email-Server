'use strict';

const API = '/api/webmail';
let token = localStorage.getItem('cm_wm_token');
let currentFolder = 'INBOX';
let currentMsgId = null;
let msgFilter = 'all';
let searchTerm = '';
let composeMode = 'new';  // 'new' | 'reply' | 'forward'
let replyToMsg = null;

// ─── Utility ─────────────────────────────────────────────────────────────────

function showSpinner(v) { document.getElementById('spinner').style.display = v ? 'flex' : 'none'; }
function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `alert alert-${type} position-fixed bottom-0 end-0 m-3 shadow`;
  t.style.cssText = 'z-index:9999;min-width:240px';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
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
  if (res.status === 401) { doLogout(); return null; }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const now = new Date();
  if (dt.toDateString() === now.toDateString()) {
    return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = document.getElementById('wm-email').value;
  const password = document.getElementById('wm-password').value;
  const errEl    = document.getElementById('login-error');
  errEl.classList.add('d-none');
  showSpinner(true);
  try {
    const data = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(r => r.json());

    if (data.token) {
      token = data.token;
      localStorage.setItem('cm_wm_token', token);
      document.getElementById('user-email').textContent = data.user.email;
      showApp();
    } else {
      errEl.textContent = data.error || 'Login failed';
      errEl.classList.remove('d-none');
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('d-none');
  } finally {
    showSpinner(false);
  }
});

function doLogout() {
  token = null;
  localStorage.removeItem('cm_wm_token');
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await apiFetch('/auth/logout', { method: 'POST' }).catch(() => {});
  doLogout();
});

// ─── App Init ─────────────────────────────────────────────────────────────────

async function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  await loadFolders();
  await loadMessages();
}

// ─── Folders ─────────────────────────────────────────────────────────────────

async function loadFolders() {
  const folders = await apiFetch('/folders');
  if (!folders) return;

  const icons = { INBOX: 'bi-inbox-fill', Sent: 'bi-send-fill', Drafts: 'bi-file-text', Trash: 'bi-trash-fill', Spam: 'bi-exclamation-octagon-fill' };
  const folderList = document.getElementById('folder-list');
  folderList.innerHTML = folders.map(f => `
    <div class="folder-item ${f.name === currentFolder ? 'active' : ''}" data-folder="${escapeHtml(f.name)}">
      <span><i class="bi ${icons[f.name] || 'bi-folder'} me-2 text-muted"></i>${escapeHtml(f.name)}</span>
      ${f.unseen_msgs > 0 ? `<span class="badge bg-primary">${f.unseen_msgs}</span>` : ''}
    </div>`).join('');

  folderList.querySelectorAll('.folder-item').forEach(el => {
    el.addEventListener('click', () => {
      currentFolder = el.dataset.folder;
      document.querySelectorAll('.folder-item').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      loadMessages();
    });
  });
}

document.getElementById('new-folder-btn').addEventListener('click', async () => {
  const name = prompt('Folder name:');
  if (!name) return;
  showSpinner(true);
  try {
    await apiFetch('/folders', { method: 'POST', body: { name } });
    await loadFolders();
  } catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
});

// ─── Message List ─────────────────────────────────────────────────────────────

async function loadMessages() {
  showSpinner(true);
  try {
    const params = new URLSearchParams({ folder: currentFolder, page: 1, limit: 100 });
    if (searchTerm) params.set('search', searchTerm);
    if (msgFilter !== 'all') params.set('flags', msgFilter);

    const data = await apiFetch(`/messages?${params}`);
    if (!data) return;

    renderMessageList(data.messages);
  } catch (err) {
    toast(err.message, 'danger');
  } finally {
    showSpinner(false);
  }
}

function renderMessageList(messages) {
  const list = document.getElementById('message-list');
  if (!messages.length) {
    list.innerHTML = '<div class="p-4 text-center text-muted"><i class="bi bi-inbox" style="font-size:2rem;opacity:.4"></i><p class="mt-2 mb-0">No messages</p></div>';
    return;
  }

  list.innerHTML = messages.map(m => {
    const toList = Array.isArray(m.to_addresses) ? m.to_addresses : JSON.parse(m.to_addresses || '[]');
    const to = toList.map(t => t.address || t).join(', ');
    return `
      <div class="msg-item ${!m.is_seen ? 'unread' : ''} ${m.id === currentMsgId ? 'active' : ''}" data-id="${m.id}">
        <div class="d-flex justify-content-between">
          <span class="msg-from">${escapeHtml(m.from_name || m.from_address)}</span>
          <span class="msg-date">${fmtDate(m.received_at)}</span>
        </div>
        <div class="msg-subject">${escapeHtml(m.subject || '(no subject)')}</div>
        <div class="d-flex justify-content-between align-items-center mt-1">
          <span class="msg-preview">${escapeHtml(to)}</span>
          <span>
            ${m.is_flagged ? '<i class="bi bi-flag-fill text-warning small"></i>' : ''}
            ${m.has_attachments ? '<i class="bi bi-paperclip text-muted small ms-1"></i>' : ''}
          </span>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.msg-item').forEach(el => {
    el.addEventListener('click', () => openMessage(el.dataset.id));
  });
}

// ─── Message Viewer ───────────────────────────────────────────────────────────

async function openMessage(id) {
  currentMsgId = id;
  document.querySelectorAll('.msg-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  hideCompose();
  showSpinner(true);

  try {
    const msg = await apiFetch(`/messages/${id}`);
    if (!msg) return;

    document.getElementById('empty-view').style.display = 'none';
    const content = document.getElementById('msg-content');
    content.style.display = 'flex';

    document.getElementById('msg-subject').textContent = msg.subject || '(no subject)';
    document.getElementById('msg-from-line').innerHTML =
      `<strong>From:</strong> ${escapeHtml(msg.from_name || '')} &lt;${escapeHtml(msg.from_address)}&gt; &nbsp; <span class="text-muted">${new Date(msg.received_at).toLocaleString()}</span>`;

    const toList = Array.isArray(msg.to_addresses) ? msg.to_addresses : JSON.parse(msg.to_addresses || '[]');
    document.getElementById('msg-to-line').innerHTML =
      `<strong>To:</strong> ${toList.map(t => escapeHtml(t.address || t)).join(', ')}`;

    // Auth badges
    const badges = document.getElementById('msg-auth-badges');
    badges.innerHTML = [
      ['SPF', msg.spf_result],
      ['DKIM', msg.dkim_result],
    ].map(([label, result]) => {
      const cls = result === 'pass' ? 'auth-pass' : result ? 'auth-fail' : 'auth-none';
      return `<span class="auth-badge ${cls}">${label}: ${result || 'none'}</span>`;
    }).join('');

    // Body
    const bodyEl = document.getElementById('msg-body-area');
    if (msg.body_html) {
      bodyEl.innerHTML = `<iframe id="msg-iframe" style="width:100%;border:none;min-height:400px" sandbox="allow-same-origin"></iframe>`;
      const iframe = document.getElementById('msg-iframe');
      iframe.onload = () => {
        iframe.style.height = iframe.contentDocument.body.scrollHeight + 'px';
      };
      iframe.srcdoc = msg.body_html;
    } else {
      bodyEl.innerHTML = `<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px">${escapeHtml(msg.body_text || '')}</pre>`;
    }

    // Attachments
    const attEl = document.getElementById('msg-attachments');
    if (msg.attachments?.length) {
      attEl.innerHTML = '<strong class="me-2">Attachments:</strong>' +
        msg.attachments.map(a => `<span class="badge bg-light text-dark me-1"><i class="bi bi-paperclip me-1"></i>${escapeHtml(a.filename || 'file')} (${(a.size_bytes / 1024).toFixed(1)} KB)</span>`).join('');
      attEl.classList.remove('d-none');
    } else {
      attEl.classList.add('d-none');
    }

    // Update flag button
    document.getElementById('flag-btn').classList.toggle('btn-warning', msg.is_flagged);
    document.getElementById('flag-btn').classList.toggle('btn-outline-warning', !msg.is_flagged);

    // Mark as read in list
    const listItem = document.querySelector(`.msg-item[data-id="${id}"]`);
    if (listItem) listItem.classList.remove('unread');

    replyToMsg = msg;
  } catch (err) {
    toast(err.message, 'danger');
  } finally {
    showSpinner(false);
  }
}

// ─── Compose ──────────────────────────────────────────────────────────────────

function showCompose(mode = 'new', msg = null) {
  composeMode = mode;
  document.getElementById('empty-view').style.display = 'none';
  document.getElementById('msg-content').style.display = 'none';
  const panel = document.getElementById('compose-panel');
  panel.style.display = 'flex';

  document.getElementById('c-to').value = '';
  document.getElementById('c-cc').value = '';
  document.getElementById('c-subject').value = '';
  document.getElementById('c-body').value = '';
  document.getElementById('compose-title').textContent = 'New Message';

  if (mode === 'reply' && msg) {
    document.getElementById('c-to').value = msg.from_address;
    document.getElementById('c-subject').value = (msg.subject || '').startsWith('Re:') ? msg.subject : `Re: ${msg.subject || ''}`;
    document.getElementById('c-body').value = `\n\n--- Original message from ${msg.from_address} ---\n${msg.body_text || ''}`;
    document.getElementById('compose-title').textContent = 'Reply';
  } else if (mode === 'forward' && msg) {
    document.getElementById('c-subject').value = (msg.subject || '').startsWith('Fwd:') ? msg.subject : `Fwd: ${msg.subject || ''}`;
    document.getElementById('c-body').value = `\n\n--- Forwarded message ---\nFrom: ${msg.from_address}\nSubject: ${msg.subject}\n\n${msg.body_text || ''}`;
    document.getElementById('compose-title').textContent = 'Forward';
  }
}

function hideCompose() {
  document.getElementById('compose-panel').style.display = 'none';
}

document.getElementById('compose-btn').addEventListener('click', () => showCompose('new'));
document.getElementById('close-compose-btn').addEventListener('click', () => {
  hideCompose();
  if (currentMsgId) {
    document.getElementById('msg-content').style.display = 'flex';
  } else {
    document.getElementById('empty-view').style.display = 'flex';
  }
});

document.getElementById('reply-btn').addEventListener('click',   () => replyToMsg && showCompose('reply', replyToMsg));
document.getElementById('forward-btn').addEventListener('click', () => replyToMsg && showCompose('forward', replyToMsg));

document.getElementById('compose-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await sendMessage(false);
});

document.getElementById('save-draft-btn').addEventListener('click', async () => {
  await sendMessage(true);
});

async function sendMessage(isDraft) {
  const to      = document.getElementById('c-to').value.split(',').map(s => s.trim()).filter(Boolean);
  const cc      = document.getElementById('c-cc').value.split(',').map(s => s.trim()).filter(Boolean);
  const subject = document.getElementById('c-subject').value;
  const body    = document.getElementById('c-body').value;

  if (!isDraft && (!to.length || !subject)) {
    return toast('To and subject are required', 'warning');
  }

  showSpinner(true);
  try {
    await apiFetch('/messages', {
      method: 'POST',
      body: {
        to: to.length === 1 ? to[0] : to,
        cc: cc.length ? cc : undefined,
        subject,
        bodyText: body,
        isDraft,
      },
    });
    toast(isDraft ? 'Draft saved' : 'Message sent!');
    if (!isDraft) {
      hideCompose();
      document.getElementById('empty-view').style.display = 'flex';
      currentMsgId = null;
    }
    await loadFolders();
    if (!isDraft) await loadMessages();
  } catch (err) {
    toast(err.message, 'danger');
  } finally {
    showSpinner(false);
  }
}

// ─── Message Actions ──────────────────────────────────────────────────────────

document.getElementById('flag-btn').addEventListener('click', async () => {
  if (!currentMsgId) return;
  try {
    const msg = await apiFetch(`/messages/${currentMsgId}`);
    await apiFetch(`/messages/${currentMsgId}`, { method: 'PATCH', body: { is_flagged: !msg.is_flagged } });
    await openMessage(currentMsgId);
    await loadMessages();
  } catch (err) { toast(err.message, 'danger'); }
});

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!currentMsgId) return;
  showSpinner(true);
  try {
    await apiFetch(`/messages/${currentMsgId}`, { method: 'DELETE' });
    document.getElementById('msg-content').style.display = 'none';
    document.getElementById('empty-view').style.display = 'flex';
    currentMsgId = null;
    replyToMsg = null;
    await loadFolders();
    await loadMessages();
    toast('Message deleted');
  } catch (err) { toast(err.message, 'danger'); }
  finally { showSpinner(false); }
});

// ─── Search & Filter ──────────────────────────────────────────────────────────

let searchTimer;
document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTerm = e.target.value;
  searchTimer = setTimeout(loadMessages, 400);
});

document.getElementById('refresh-btn').addEventListener('click', async () => {
  await loadFolders();
  await loadMessages();
});

document.querySelectorAll('[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    msgFilter = btn.dataset.filter;
    loadMessages();
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

(async () => {
  if (token) {
    try {
      const profile = await apiFetch('/profile');
      if (profile) {
        document.getElementById('user-email').textContent = `${profile.username}@${profile.domain}`;
        showApp();
        return;
      }
    } catch {}
    token = null;
    localStorage.removeItem('cm_wm_token');
  }
})();
