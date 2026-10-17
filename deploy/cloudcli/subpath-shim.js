// CloudCLI is built for the site root, but this server exposes it under /code/.
// Loaded before the app bundle: it sets the router basename and prefixes the
// app's root-absolute API, WebSocket and service-worker URLs with /code.
(() => {
  const base = '/code';
  window.__ROUTER_BASENAME__ = base;
  const rooted = path => path.startsWith('/') && !path.startsWith('//') && path !== base && !path.startsWith(base + '/');
  const fix = value => {
    if (typeof value === 'string') {
      if (rooted(value)) return base + value;
      if (!/^(https?|wss?):\/\//.test(value)) return value;
    }
    if (typeof value !== 'string' && !(value instanceof URL)) return value;
    const url = new URL(value, location.href);
    if (url.host !== location.host || !rooted(url.pathname)) return value;
    url.pathname = base + url.pathname;
    return typeof value === 'string' ? url.href : url;
  };

  const fetch = window.fetch;
  window.fetch = function (input, init) {
    if (input instanceof Request) {
      const url = fix(input.url);
      if (url !== input.url) input = new Request(url, input);
      return fetch.call(this, input, init);
    }
    return fetch.call(this, fix(input), init);
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return open.call(this, method, fix(url), ...rest);
  };

  const wrap = Native => {
    const Wrapped = function (url, ...rest) { return new Native(fix(url), ...rest); };
    Wrapped.prototype = Native.prototype;
    Object.setPrototypeOf(Wrapped, Native);
    return Wrapped;
  };
  window.WebSocket = wrap(window.WebSocket);
  if (window.EventSource) window.EventSource = wrap(window.EventSource);

  // The upstream worker would otherwise claim scope "/" and intercept the JLPT site.
  if (navigator.serviceWorker) {
    const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = (url, options) => register(fix(url), {...options, scope: base + '/'});
  }

  // Subscription quota pill (5-hour and weekly windows) from quota.py.
  const style = document.createElement('style');
  style.textContent = `
    .cc-quota { position: fixed; z-index: 60; top: calc(env(safe-area-inset-top) + 66px); right: 16px; font: 500 12px/1 system-ui, sans-serif; }
    .cc-quota button { display: flex; gap: 6px; align-items: center; min-height: 28px; padding: 0 10px; color: #3f3f46; background: rgba(255,255,255,.92); border: 1px solid #e4e4e7; border-radius: 999px; box-shadow: 0 1px 3px rgba(0,0,0,.08); cursor: pointer; font: inherit; }
    .cc-quota [data-level="warn"] { color: #b45309; }
    .cc-quota [data-level="high"] { color: #dc2626; }
    .cc-quota .cc-quota-panel { position: absolute; top: 34px; right: 0; width: max-content; max-width: calc(100vw - 24px); padding: 10px 12px; color: #3f3f46; background: #fff; border: 1px solid #e4e4e7; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.12); line-height: 1.7; }
    .dark .cc-quota button, .dark .cc-quota .cc-quota-panel { color: #e4e4e7; background: rgba(39,39,42,.94); border-color: #3f3f46; }
    .dark .cc-quota [data-level="warn"] { color: #fbbf24; }
    .dark .cc-quota [data-level="high"] { color: #f87171; }
    @media (max-width: 767px) { .cc-quota { top: calc(env(safe-area-inset-top) + 58px); right: auto; left: 12px; } .cc-quota .cc-quota-panel { right: auto; left: 0; } }
  `;
  const root = document.createElement('div');
  root.className = 'cc-quota';
  root.innerHTML = '<button type="button" aria-expanded="false" title="Claude 订阅额度">额度 …</button><div class="cc-quota-panel" hidden></div>';
  const [pill, panel] = root.children;
  pill.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    pill.setAttribute('aria-expanded', String(!panel.hidden));
  });
  document.addEventListener('click', event => {
    if (!root.contains(event.target)) { panel.hidden = true; pill.setAttribute('aria-expanded', 'false'); }
  });

  const level = percent => percent >= 80 ? 'high' : percent >= 50 ? 'warn' : 'ok';
  const when = iso => {
    if (!iso) return '—';
    const date = new Date(iso);
    const time = date.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
    return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  };
  const text = (tag, content, percent) => {
    const node = document.createElement(tag);
    node.textContent = content;
    if (percent != null) node.dataset.level = level(percent);
    return node;
  };
  function render(data) {
    pill.replaceChildren();
    panel.replaceChildren();
    if (data.error) {
      pill.append(text('span', data.error === 'token_expired' ? '额度：登录过期' : '额度不可用'));
      panel.append(text('div', data.error === 'token_expired' ? '令牌已过期，在本页发一条消息后会自动刷新。' : `暂时无法读取额度（${data.error}）。`));
      return;
    }
    const rows = [['5h', '5 小时额度', data.five_hour], ['周', '每周额度', data.seven_day]];
    rows.forEach(([short, , win], index) => {
      if (index) pill.append(text('span', '·'));
      pill.append(text('span', `${short} ${Math.round(win.percent ?? 0)}%`, win.percent));
    });
    for (const [, label, win] of rows) panel.append(text('div', `${label} 已用 ${Math.round(win.percent ?? 0)}%，${when(win.resets_at)} 重置`, win.percent));
    panel.append(text('div', `${(data.plan || '').toUpperCase()} 套餐 · ${new Date(data.checked_at * 1000).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})} 更新`));
  }
  async function refresh() {
    try {
      const response = await fetch.call(window, base + '/_quota', {credentials: 'same-origin'});
      render(response.ok ? await response.json() : {error: `http_${response.status}`});
    } catch {
      render({error: 'offline'});
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.head.append(style);
    document.body.append(root);
    refresh();
    setInterval(refresh, 120000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  });
})();
