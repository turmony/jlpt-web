// Entry point of the main script. The userscript loader runs the bundle with the free variable
// JLPT_NEWS = {base, token, sites, install, debug}.
import {configure} from './api.mjs';
import {configureDebug, debug} from './debug.mjs';
import {mountUi, injectPageStyle} from './ui.mjs';
import {mountDock} from './dock.mjs';
import {Marker} from './marks.mjs';
import {mountReader} from './reader.mjs';
import {mountWordCard} from './wordcard.mjs';
import {mountPanel} from './panel.mjs';

// The page's own DOM cannot be styled from the shadow root: the selected sentence (.jlpt-sel, pale
// yellow) and the selected part (.jlpt-part, deeper yellow) are styled from the page's <head>.
// While the bottom sheet is open (panel.mjs) the page can scroll its end above the sheet.
const PAGE_CSS = parts => `${parts} { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none }
.jlpt-t { -webkit-tap-highlight-color: transparent }
.jlpt-sel { background: #fff3b0; touch-action: none }
.jlpt-part { background: #ffd54f }
html[data-jlpt-panel="sheet"] { padding-bottom: calc(55vh + 48px) }`;

const STATES = {tokenizing: '分词中', ready: '就绪', error: '出错'};

// One overlay line per change of the dock status, plus the error lines; '已标出 N 个词' once, after
// the first pass that wrapped words (or ended without any).
function statusLogger(marker) {
  let last = '';
  let counted = false;
  return ({state, errors}) => {
    const html = document.documentElement.dataset;
    const line = `状态: ${STATES[state] || state} 词数 ${html.jlptWords ?? '-'} 重包 ${html.jlptRewraps ?? '-'}`;
    const key = line + errors.map(info => info.reason).join('|');
    if (key === last) return;
    last = key;
    debug(line, state === 'error' ? 'error' : state === 'ready' ? 'ok' : undefined);
    for (const info of errors) debug(`${info.stage_label}失败${info.location ? `（${info.location}）` : ''}：${info.reason}`, 'error');
    if (!counted && marker.marked && (Number(html.jlptWords) > 0 || state !== 'tokenizing')) {
      counted = true;
      debug(`已标出 ${html.jlptWords} 个词`, 'ok');
    }
  };
}

configureDebug(JLPT_NEWS.debug);
debug('主脚本已运行');
const site = JLPT_NEWS.sites.find(s => s.origin === location.origin && new RegExp(s.path).test(location.pathname));
if (!site) {
  debug(`当前页面路径不匹配 (${location.pathname})`, 'warn');
} else {
  debug(`站点已匹配: ${site.name}`, 'ok');
  configure({base: JLPT_NEWS.base, token: JLPT_NEWS.token, install: JLPT_NEWS.install});
  const {layer} = mountUi();
  let marker;
  const dock = mountDock(layer, {onRetokenize: () => marker.retokenize()});
  marker = new Marker(site, {onStatus: status => { dock.setStatus(status); logStatus(status); }});
  const logStatus = statusLogger(marker); // onStatus is first called by marker.start()
  mountWordCard(layer);
  mountPanel(layer, marker);
  mountReader(marker, () => marker.roots);
  // The page itself is left alone until `load` (see marks.mjs); the style goes in with the marks.
  const style = () => injectPageStyle(PAGE_CSS(site.parts.join(', ')));
  if (document.readyState === 'complete') {
    style();
    debug('页面 load 完成（主脚本运行前）');
  } else {
    addEventListener('load', () => { style(); debug('页面 load 完成'); }, {once: true});
  }
  marker.start();
  document.documentElement.dataset.jlptNews = 'ready';
}
