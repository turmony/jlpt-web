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

  // On-screen keyboard on iPhone/iPad. Upstream lifts its fixed workspace shell by
  // innerHeight - visualViewport.height, rewritten only on visualViewport resize. Safari keeps
  // the layout viewport's height and, racing that handler, pans the visual viewport up to reveal
  // the composer, so the lift is counted twice (composer at the top of the screen or far above
  // the keyboard); when the resize event is missed the lift goes stale (composer behind the
  // keyboard, or stranded mid-screen after it closes). Pin the shell to the visual viewport
  // instead, and re-read it after focus changes, once the keyboard animation is over.
  // ?kbfix=0 restores upstream behaviour and ?kbdebug=1 shows the numbers; both are remembered.
  const flag = (name, fallback) => {
    try {
      const value = new URLSearchParams(location.search).get(name);
      if (value !== null) localStorage.setItem('cc-' + name, value === '0' ? '0' : '1');
      return (localStorage.getItem('cc-' + name) ?? fallback) === '1';
    } catch {
      return fallback === '1';
    }
  };
  const kbfix = flag('kbfix', '1');
  const kbdebug = flag('kbdebug', '0');
  const vv = window.visualViewport;
  const events = [];
  let debugPanel = null;
  function syncViewport(event) {
    if (!vv) return;
    const rootStyle = document.documentElement.style;
    // Pinch zoom shrinks the visual viewport too; leave the shell full size then.
    if (Math.abs(vv.scale - 1) < 0.01) {
      rootStyle.setProperty('--cc-vv-top', `${vv.offsetTop}px`);
      rootStyle.setProperty('--cc-vv-height', `${vv.height}px`);
    } else {
      rootStyle.removeProperty('--cc-vv-top');
      rootStyle.removeProperty('--cc-vv-height');
    }
    if (debugPanel) renderDebug(event?.type);
  }
  function renderDebug(type) {
    const shell = document.querySelector('.fixed.inset-0[style*="keyboard-height"]')?.getBoundingClientRect();
    const composer = document.querySelector('.chat-composer-shell')?.getBoundingClientRect();
    const keyboardTop = Math.round(vv.offsetTop + vv.height);
    const line = `L=${innerHeight} V=${Math.round(vv.height)} O=${Math.round(vv.offsetTop)} ` +
      `K'=${document.documentElement.style.getPropertyValue('--keyboard-height') || '-'} ` +
      `shell=${shell ? `${Math.round(shell.top)}..${Math.round(shell.bottom)}` : '-'} ` +
      `gap=${composer ? keyboardTop - Math.round(composer.bottom) : '-'}`;
    if (type) {
      events.unshift(`${new Date().toTimeString().slice(3, 8)} ${type}: ${line}`);
      events.length = Math.min(events.length, 8);
    }
    debugPanel.textContent = `kbfix=${kbfix ? 1 : 0} focus=${document.activeElement?.tagName || '-'}\n${line}\n\n${events.join('\n')}`;
  }
  if (vv) {
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
    window.addEventListener('resize', syncViewport);
    // visualViewport's values stay current even when Safari skips its events.
    for (const type of ['focusin', 'focusout']) {
      document.addEventListener(type, event => {
        syncViewport(event);
        setTimeout(syncViewport, 300, {type: type + '+300'});
        setTimeout(syncViewport, 700, {type: type + '+700'});
      });
    }
  }

  // Subscription quota pill (5-hour and weekly windows) from quota.py.
  // Also turns off upstream's content-visibility on transcript rows: WebKit lays an
  // off-screen row out at its 180/240px estimate and then at its real height without
  // correcting the scroll position, so on iPhone/iPad the transcript jumps by up to
  // thousands of pixels while scrolling up, worst right after a reply (the refresh
  // remounts rows and they lose their remembered heights). LazyMessageRow already
  // unmounts distant rows, so this costs little.
  const style = document.createElement('style');
  style.textContent = `
    .chat-messages-pane .chat-message { content-visibility: visible; }
    .cc-quota { position: fixed; z-index: 60; top: calc(env(safe-area-inset-top) + 66px); right: 16px; font: 500 12px/1 system-ui, sans-serif; }
    .cc-quota button { display: flex; gap: 6px; align-items: center; min-height: 28px; padding: 0 10px; color: #3f3f46; background: rgba(255,255,255,.92); border: 1px solid #e4e4e7; border-radius: 999px; box-shadow: 0 1px 3px rgba(0,0,0,.08); cursor: pointer; font: inherit; }
    .cc-quota [data-level="warn"] { color: #b45309; }
    .cc-quota [data-level="high"] { color: #dc2626; }
    .cc-quota .cc-quota-panel { position: absolute; top: 34px; right: 0; width: max-content; max-width: calc(100vw - 24px); padding: 10px 12px; color: #3f3f46; background: #fff; border: 1px solid #e4e4e7; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.12); line-height: 1.7; }
    .dark .cc-quota button, .dark .cc-quota .cc-quota-panel { color: #e4e4e7; background: rgba(39,39,42,.94); border-color: #3f3f46; }
    .dark .cc-quota [data-level="warn"] { color: #fbbf24; }
    .dark .cc-quota [data-level="high"] { color: #f87171; }
    @media (max-width: 767px) { .cc-quota { top: calc(env(safe-area-inset-top) + 58px); right: auto; left: 12px; } .cc-quota .cc-quota-panel { right: auto; left: 0; } }
    .cc-kbdebug { position: fixed; z-index: 70; top: calc(var(--cc-vv-top, 0px) + 4px); left: 4px; right: 4px; max-height: 45vh; overflow: hidden; margin: 0; padding: 6px 8px; color: #fff; background: rgba(0,0,0,.72); border-radius: 6px; font: 10px/1.4 ui-monospace, monospace; white-space: pre-wrap; pointer-events: none; }
  ` + (kbfix && vv ? `
    .fixed.inset-0[style*="keyboard-height"] { top: var(--cc-vv-top, 0px) !important; bottom: auto !important; height: var(--cc-vv-height, 100%) !important; }
    body.pwa-mode .fixed.inset-0[style*="keyboard-height"] { top: calc(var(--cc-vv-top, 0px) + var(--header-total-padding)) !important; height: calc(var(--cc-vv-height, 100%) - var(--header-total-padding)) !important; }
  ` : '');
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
    syncViewport();
    if (kbdebug && vv) {
      debugPanel = document.createElement('pre');
      debugPanel.className = 'cc-kbdebug';
      document.body.append(debugPanel);
      renderDebug('load');
      setInterval(renderDebug, 500);
    }
    refresh();
    setInterval(refresh, 120000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  });
})();
