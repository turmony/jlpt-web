const form = document.querySelector('#password-form');
const statusEl = document.querySelector('#status');
const logoutBtn = document.querySelector('#logout-btn');
const sessionCountEl = document.querySelector('#session-count');
const sessionsMsgEl = document.querySelector('#sessions-msg');
const sessionListEl = document.querySelector('#session-list');
const revokeOthersBtn = document.querySelector('#revoke-others-btn');

function showMsg(el, text, ok) {
  if (!el) return;
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'error');
  el.hidden = false;
}

function fmtTime(sec) {
  if (!sec) return '未知';
  const d = new Date(sec * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtRelative(sec) {
  if (!sec) return '未记录';
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function daysLeft(expires) {
  const days = Math.max(0, Math.ceil((expires - Date.now() / 1000) / 86400));
  return `${days} 天`;
}

async function performLogout() {
  if (logoutBtn) logoutBtn.disabled = true;
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    // Redirect to login regardless so the browser drops to the gate.
  }
  location.replace('/login.html');
}

async function revokeSession(payload, btn) {
  if (btn) btn.disabled = true;
  if (sessionsMsgEl) sessionsMsgEl.hidden = true;
  try {
    const response = await fetch('/api/auth/sessions/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      location.replace('/login.html?next=/account/');
      return;
    }
    if (!response.ok) throw new Error(data.error || '操作失败');
    if (data.self_revoked) {
      location.replace('/login.html');
      return;
    }
    showMsg(
      sessionsMsgEl,
      payload.scope === 'others'
        ? `已移除其他 ${data.revoked || 0} 台设备的登录凭证。`
        : '已移除该设备的登录 Cookie。',
      true,
    );
    await loadSessions();
  } catch (err) {
    showMsg(sessionsMsgEl, err.message || '移除凭证失败', false);
    if (btn) btn.disabled = false;
  }
}

function renderSessions(items) {
  sessionListEl.replaceChildren();
  const total = items.length;
  sessionCountEl.textContent = `当前共有 ${total} 台有效设备（Cookie 有效期 1 年，自动检查续用）`;
  if (revokeOthersBtn) {
    revokeOthersBtn.hidden = total <= 1;
    revokeOthersBtn.disabled = false;
  }

  if (!total) {
    const empty = document.createElement('li');
    empty.className = 'hint';
    empty.textContent = '暂无有效会话。';
    sessionListEl.appendChild(empty);
    return;
  }

  for (const s of items) {
    const li = document.createElement('li');
    li.className = 'session-item';

    const top = document.createElement('div');
    top.className = 'session-top';

    const title = document.createElement('div');
    title.className = 'session-title';

    const dev = document.createElement('span');
    dev.className = 'dev-name';
    dev.textContent = s.device_name || '未知设备';
    title.appendChild(dev);

    if (s.current) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = '当前设备';
      title.appendChild(pill);
    }

    const cid = document.createElement('span');
    cid.className = 'cookie-id';
    cid.textContent = `#${s.id}`;
    title.appendChild(cid);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'danger-outline mini';
    btn.textContent = s.current ? '退出本机' : '移除 Cookie';
    btn.addEventListener('click', () => {
      revokeSession({ id: s.id }, btn);
    });

    top.appendChild(title);
    top.appendChild(btn);
    li.appendChild(top);

    const meta = document.createElement('div');
    meta.className = 'session-meta';

    const parts = [
      `IP：${s.ip || '未记录'}`,
      `最近活跃：${s.last_seen ? `${fmtRelative(s.last_seen)}（${fmtTime(s.last_seen)}）` : '未记录'}`,
      `首次登录：${fmtTime(s.created_at)}`,
      `有效期剩余：${daysLeft(s.expires)}`,
    ];
    for (const text of parts) {
      const span = document.createElement('span');
      span.textContent = text;
      meta.appendChild(span);
    }
    li.appendChild(meta);

    if (s.user_agent) {
      const ua = document.createElement('div');
      ua.className = 'session-ua';
      ua.title = s.user_agent;
      ua.textContent = s.user_agent;
      li.appendChild(ua);
    }

    sessionListEl.appendChild(li);
  }
}

async function loadSessions() {
  try {
    const response = await fetch('/api/auth/sessions', { cache: 'no-store' });
    if (response.status === 401) {
      location.replace('/login.html?next=/account/');
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '读取设备列表失败');
    renderSessions(Array.isArray(data.sessions) ? data.sessions : []);
  } catch (err) {
    sessionCountEl.textContent = '读取设备列表失败';
    showMsg(sessionsMsgEl, err.message || '读取设备列表失败', false);
  }
}

const params = new URLSearchParams(location.search);
if (params.get('logout') === '1') {
  performLogout();
} else {
  loadSessions();
}

revokeOthersBtn?.addEventListener('click', () => {
  revokeSession({ scope: 'others' }, revokeOthersBtn);
});

form?.addEventListener('submit', async event => {
  event.preventDefault();
  const currentPassword = document.querySelector('#current-password').value;
  const newPassword = document.querySelector('#new-password').value;
  const confirmPassword = document.querySelector('#confirm-password').value;
  const submitBtn = form.querySelector('button[type="submit"]');

  statusEl.hidden = true;
  if (newPassword.length < 8) {
    showMsg(statusEl, '新密码长度至少为 8 位', false);
    return;
  }
  if (newPassword !== confirmPassword) {
    showMsg(statusEl, '两次输入的新密码不一致', false);
    return;
  }

  submitBtn.disabled = true;
  try {
    const response = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || '修改密码失败');
    }
    form.reset();
    showMsg(statusEl, '密码已更新，其他设备需重新登录。', true);
    await loadSessions();
  } catch (err) {
    showMsg(statusEl, err.message || '修改密码失败', false);
  } finally {
    submitBtn.disabled = false;
  }
});

logoutBtn?.addEventListener('click', performLogout);
