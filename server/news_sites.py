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


def allowed_origins(config):
    return {entry['origin'] for entry in sites(config)}


def _line(text):
    """Collapse any line breaks so a value stays on one `//` metadata line."""
    return ' '.join(str(text).split())


_HEADER = """// ==UserScript==
// @name         JLPT 新闻查词
// @namespace    @BASE@
// @version      1
// @description  在新闻页面上查词、分析句子（令牌只属于这台设备）
@MATCHES@
// @run-at       document-start
// @inject-into  content
// @noframes
// ==/UserScript==
"""

_BODY = r"""(function () {
  'use strict';
  const CONFIG = @CONFIG@;

  // The failure button is built lazily: at document-start <body> may not exist yet.
  function showFailure(reason, withLink) {
    const mount = () => {
      const host = document.createElement('jlpt-news-loader');
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent =
        '.b{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:40px;height:40px;' +
        'border:0;border-radius:50%;background:#d93025;color:#fff;font:bold 20px sans-serif;cursor:pointer}' +
        '.p{position:fixed;right:16px;bottom:64px;z-index:2147483647;max-width:260px;padding:10px 12px;' +
        'border-radius:8px;background:#fff;color:#222;font:14px/1.5 sans-serif;box-shadow:0 2px 10px #0004}' +
        '.p[hidden]{display:none}.p a{color:#1a73e8;word-break:break-all}';
      const button = document.createElement('button');
      button.className = 'b';
      button.textContent = '!';
      const panel = document.createElement('div');
      panel.className = 'p';
      panel.hidden = true;
      panel.append('加载主脚本失败：' + reason);
      if (withLink) {
        panel.append(document.createElement('br'));
        const link = document.createElement('a');
        link.href = CONFIG.install;
        link.textContent = '重新安装';
        link.target = '_blank';
        panel.append(link);
      }
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
    script.textContent = '(function(JLPT_NEWS){' + code + '\n})(' + config + ');';
    document.documentElement.append(script);
    script.remove();
  }

  function run(code) {
    try {
      new Function('JLPT_NEWS', code)(CONFIG);
    } catch (error) {
      // Some extension environments forbid eval; fall back to a page <script>.
      if (error && error.name === 'EvalError') inject(code);
      else throw error;
    }
  }

  async function main() {
    let code;
    try {
      const response = await fetch(CONFIG.base + '/api/news/client.js', {
        headers: { Authorization: 'Bearer ' + CONFIG.token },
        cache: 'no-store',
      });
      if (response.status === 401) return showFailure('令牌已失效，请重新安装脚本', true);
      if (!response.ok) return showFailure('服务器返回 ' + response.status, false);
      code = await response.text();
    } catch (error) {
      return showFailure('网络连接失败', false);
    }
    run(code);
  }

  main();
})();
"""


def loader_script(base, token, site_list):
    base = base.rstrip('/')
    config = {'base': base, 'token': token, 'sites': site_list, 'install': base + '/news-script/'}
    # Keep the JSON from ever closing or confusing an inline <script>.
    config_json = json.dumps(config, ensure_ascii=False).replace('</', '<\\/').replace('<!--', '<\\!--')
    matches = '\n'.join(f"// @match        {_line(entry['match'])}" for entry in site_list)
    header = _HEADER.replace('@BASE@', _line(base)).replace('@MATCHES@', matches)
    return header + _BODY.replace('@CONFIG@', config_json)
