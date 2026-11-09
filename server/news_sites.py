"""News site table and the generated `.user.js` loader."""

import json
import re

DEFAULT_SITES = [
    {
        "name": "雅虎新闻",
        "origin": "https://news.yahoo.co.jp",
        "match": "https://news.yahoo.co.jp/articles/*",
        "path": "^/articles/[0-9a-f]+$",
        "parts": ["h1", ".article_body"],
    }
]

_REQUIRED = ('name', 'origin', 'match', 'path', 'parts')
# Matched with fullmatch: `$` would also accept a trailing newline. No leading zeros, as browsers send it.
_ORIGIN = re.compile(r'https?://[A-Za-z0-9.-]+(?::([1-9][0-9]{0,4}))?')


def _valid_origin(origin):
    found = _ORIGIN.fullmatch(origin)
    return bool(found) and (found[1] is None or int(found[1]) <= 65535)


def _check(entry):
    if not isinstance(entry, dict):
        raise ValueError('news site must be an object')
    for key in _REQUIRED:
        if key not in entry:
            raise ValueError(f'news site is missing {key!r}')
    for key in ('name', 'origin', 'match', 'path'):
        if not isinstance(entry[key], str) or not entry[key]:
            raise ValueError(f'news site {key!r} must be a non-empty string')
    if not _valid_origin(entry['origin']):
        raise ValueError(f"news site origin must be http(s)://host[:port]: {entry['origin']!r}")
    try:
        re.compile(entry['path'])
    except re.error as exc:
        raise ValueError(f"news site path is not a regex: {exc}") from exc
    parts = entry['parts']
    if not isinstance(parts, list) or not parts or not all(isinstance(p, str) and p for p in parts):
        raise ValueError('news site parts must be a non-empty list of strings')
    return entry


def sites(config):
    listed = config.get('news_sites')
    if listed is None:
        return list(DEFAULT_SITES)
    if not isinstance(listed, list):
        raise ValueError('news_sites must be a list')
    return [_check(entry) for entry in listed]


def debug_enabled(config):
    """`news_debug`: whether the loader shows its on-screen debug lines. Optional, default true."""
    value = config.get('news_debug', True)
    if not isinstance(value, bool):
        raise ValueError(f'news_debug must be true or false, not {value!r}')
    return value


def online_update_enabled(config):
    """`news_online_update`: whether the server hands out the loader and the main script. Optional, default true."""
    value = config.get('news_online_update', True)
    if not isinstance(value, bool):
        raise ValueError(f'news_online_update must be true or false, not {value!r}')
    return value


def allowed_origins(config):
    return {entry['origin'] for entry in sites(config)}


# Bump this whenever the generated loader text changes (the header, the overlay or the loader code):
# Userscripts only replaces an installed loader (through @updateURL) when the served @version is higher,
# while the main script updates on every page load. The version is shown in the script name, so a phone's
# script list tells which loader is installed.
LOADER_VERSION = 3


def _line(text):
    """Collapse any line breaks so a value stays on one `//` metadata line."""
    return ' '.join(str(text).split())


_HEADER = """// ==UserScript==
// @name         JLPT 新闻查词 v@VERSION@
// @namespace    @BASE@
// @version      @VERSION@
// @description  在新闻页面上查词、分析句子
// @updateURL    @BASE@/api/news/loader.user.js
// @downloadURL  @BASE@/api/news/loader.user.js
@MATCHES@
// @run-at       document-start
// @inject-into  content
// @noframes
// ==/UserScript==
"""

# The on-screen debug overlay: a small open-shadow <jlpt-news-debug> at the top left that lists, with
# the time since the loader started, how far loading got. Only its two buttons take taps; the text
# lets taps through to the page. The main script adds lines through JLPT_NEWS.debug, or through the
# 'jlpt-news-debug' event when it runs as an injected <script> (functions do not survive the JSON).
# Never shows the request headers or CONFIG itself.
_DEBUG_ON = r"""  const debug = (function () {
    // A debug aid must never stop loading: if the overlay cannot be built, lines go nowhere.
    const quiet = function () {};
    quiet.wrap = (call) => call;
    quiet.injected = function () {};
    try {
      return overlay();
    } catch (error) {
      return quiet;
    }

    function overlay() {
      const started = Date.now();
      const LEVELS = { ok: 'ok', warn: 'warn', error: 'error' };
      const MAX = 40;
      const lines = [];
      const host = document.createElement('jlpt-news-debug');
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent =
        ':host{all:initial}' +
        '.d{position:fixed;top:calc(env(safe-area-inset-top, 0px) + 4px);left:4px;z-index:2147483647;' +
        'box-sizing:border-box;max-width:92vw;padding:2px 6px 4px;border-radius:6px;background:rgba(0,0,0,.75);' +
        'color:#fff;font:11px/1.35 ui-monospace,Menlo,monospace;text-align:left;white-space:pre-wrap;' +
        'overflow-wrap:anywhere;-webkit-text-size-adjust:100%;pointer-events:none}' +
        '.h{display:flex;gap:4px}' +
        '.h button{pointer-events:auto;margin:0;padding:3px 6px;border:0;border-radius:4px;background:#ffffff26;' +
        'color:#fff;font:bold 11px/1.2 ui-monospace,Menlo,monospace;cursor:pointer}' +
        '.ok{color:#8eea8e}.warn{color:#ffd54f}.error{color:#ff8a80}' +
        '.d.c{padding:2px}.d.c .l,.d.c .x{display:none}.d[hidden]{display:none}';
      const box = document.createElement('div');
      box.className = 'd';
      const head = document.createElement('div');
      head.className = 'h';
      const toggle = document.createElement('button');
      toggle.className = 't';
      toggle.type = 'button';
      toggle.textContent = 'JLPT 调试';
      toggle.setAttribute('aria-expanded', 'true');
      const close = document.createElement('button');
      close.className = 'x';
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', '关闭调试信息');
      const list = document.createElement('div');
      list.className = 'l';
      toggle.addEventListener('click', () => {
        const collapsed = box.className === 'd';
        box.className = collapsed ? 'd c' : 'd';
        toggle.setAttribute('aria-expanded', String(!collapsed));
      });
      close.addEventListener('click', () => { box.hidden = true; });
      head.append(toggle, close);
      box.append(head, list);
      root.append(style, box);
      // At document-start the root may still be missing, even at the first readystatechange.
      const mount = () => {
        try {
          if (!document.documentElement) return;
          document.removeEventListener('readystatechange', mount);
          document.documentElement.append(host);
        } catch (error) {
          // No overlay then; loading goes on.
        }
      };
      if (document.documentElement) mount();
      else document.addEventListener('readystatechange', mount);

      function debug(message, level) {
        try {
          const line = document.createElement('div');
          line.className = Object.prototype.hasOwnProperty.call(LEVELS, level) ? LEVELS[level] : '';
          line.textContent = '+' + (Date.now() - started) + 'ms ' + String(message);
          list.append(line);
          lines.push(line);
          if (lines.length > MAX) lines.shift().remove();
        } catch (error) {
          // The overlay must never stop the loader.
        }
      }

      // Lines from a main script that runs as an injected <script> (see inject below).
      let injectedEnded = false;
      document.addEventListener('jlpt-news-debug', (event) => {
        let data;
        try {
          data = JSON.parse(event.detail);
        } catch (error) {
          return;
        }
        if (!data || typeof data.message !== 'string') return;
        if (data.end) injectedEnded = true;
        debug(data.message, data.level);
      });
      const say = "document.dispatchEvent(new CustomEvent('jlpt-news-debug',{detail:JSON.stringify(";
      debug.wrap = (call) =>
        'try{' + call + '\n' + say + "{message:'主脚本已执行',level:'ok',end:true})}))}" +
        'catch(e){' + say + "{message:'主脚本出错: '+String(e&&e.message||e),level:'error',end:true})}));throw e}";
      debug.injected = () => {
        if (!injectedEnded) debug('注入的主脚本没有运行（可能被网页的安全策略拦截）', 'error');
      };

      debug('加载器已运行 v@VERSION@ 页面 ' + location.pathname + ' readyState=' + document.readyState);
      try {
        const site = CONFIG.sites.find((s) => s.origin === location.origin && new RegExp(s.path).test(location.pathname));
        if (site) debug('匹配的网站: ' + site.name, 'ok');
        else debug('当前页面不在网站表内', 'warn');
      } catch (error) {
        debug('网站表出错: ' + String((error && error.message) || error), 'error');
      }
      return debug;
    }
  })();
"""

_DEBUG_OFF = r"""  const debug = function () {};
  debug.wrap = (call) => call;
  debug.injected = function () {};
"""

_BODY = r"""(function () {
  'use strict';
  const CONFIG = @CONFIG@;
@DEBUG@
  // The failure button is built lazily: at document-start <body> may not exist yet.
  function showFailure(message) {
    const mount = () => {
      const host = document.createElement('jlpt-news-loader');
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent =
        '.b{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:40px;height:40px;' +
        'border:0;border-radius:50%;background:#d93025;color:#fff;font:bold 20px sans-serif;cursor:pointer}' +
        '.p{position:fixed;right:16px;bottom:64px;z-index:2147483647;max-width:260px;padding:10px 12px;' +
        'border-radius:8px;background:#fff;color:#222;font:14px/1.5 sans-serif;box-shadow:0 2px 10px #0004}' +
        '.p[hidden]{display:none}';
      const button = document.createElement('button');
      button.className = 'b';
      button.textContent = '!';
      const panel = document.createElement('div');
      panel.className = 'p';
      panel.hidden = true;
      panel.append(message);
      button.addEventListener('click', () => { panel.hidden = !panel.hidden; });
      root.append(style, button, panel);
      document.documentElement.append(host);
    };
    if (document.documentElement) mount();
    else document.addEventListener('readystatechange', mount, { once: true });
  }

  function inject(code) {
    const script = document.createElement('script');
    const config = JSON.stringify(CONFIG).replace(/</g, '\\u003c');
    script.textContent = debug.wrap('(function(JLPT_NEWS){' + code + '\n})(' + config + ');');
    document.documentElement.append(script);
    script.remove();
    debug.injected();
  }

  function describe(error) {
    return String((error && error.message) || error);
  }

  function run(code) {
    let start;
    try {
      start = new Function('JLPT_NEWS', code);
    } catch (error) {
      // Some extension environments forbid eval; fall back to a page <script>.
      if (error && error.name === 'EvalError') {
        debug('执行方式: 注入 <script>（eval 被禁用）');
        return inject(code);
      }
      throw error;
    }
    debug('执行方式: new Function');
    // Kept apart from the eval check, so an error from the running script never runs it twice.
    try {
      start(Object.assign({}, CONFIG, { debug: (message, level) => debug(message, level) }));
      debug('主脚本已执行', 'ok');
    } catch (error) {
      debug('主脚本出错: ' + describe(error), 'error');
      showFailure('主脚本出错：' + describe(error));
    }
  }

  const failed = (reason, detail) => {
    debug('加载主脚本失败: ' + reason + (detail ? '（' + detail + '）' : ''), 'error');
    showFailure('加载主脚本失败：' + reason);
  };

  function size(text) {
    return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length;
  }

  async function main() {
    let code;
    debug('正在取主脚本…');
    try {
      const response = await fetch(CONFIG.base + '/api/news/client.js', { cache: 'no-store' });
      if (!response.ok) return failed('服务器返回 ' + response.status);
      code = await response.text();
    } catch (error) {
      return failed('网络连接失败', describe(error));
    }
    debug('主脚本已取到: ' + size(code) + ' 字节', 'ok');
    run(code);
  }

  main().catch((error) => failed(describe(error)));
})();
"""


def loader_script(base, site_list, debug=True):
    """The loader `.user.js`, the same for every device. With debug, it shows its on-screen trace (see _DEBUG_ON)."""
    base = base.rstrip('/')
    config = {'base': base, 'sites': site_list, 'debug': bool(debug)}
    # Keep the JSON from ever closing or confusing an inline <script>.
    config_json = json.dumps(config, ensure_ascii=False).replace('</', '<\\/').replace('<!--', '<\\!--')
    matches = '\n'.join(f"// @match        {_line(entry['match'])}" for entry in site_list)
    # One pass over the header, so a value that looks like another placeholder stays text.
    values = {'@VERSION@': str(LOADER_VERSION), '@BASE@': _line(base), '@MATCHES@': matches}
    header = re.sub('@VERSION@|@BASE@|@MATCHES@', lambda found: values[found[0]], _HEADER)
    # The placeholder for the debug code goes first: the config may contain any text, so it goes last.
    body = _BODY.replace('@DEBUG@', _DEBUG_ON if debug else _DEBUG_OFF).replace('@VERSION@', str(LOADER_VERSION))
    return header + body.replace('@CONFIG@', config_json)
