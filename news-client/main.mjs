// Entry point of the main script. The userscript loader runs the bundle with the free variable
// JLPT_NEWS = {base, token, sites, install}.
import {configure} from './api.mjs';
import {mountUi, injectPageStyle} from './ui.mjs';
import {mountDock} from './dock.mjs';
import {Marker} from './marks.mjs';
import {mountReader} from './reader.mjs';
import {mountWordCard} from './wordcard.mjs';

// The page's own DOM cannot be styled from the shadow root: the selected sentence (.jlpt-sel, pale
// yellow) and the selected part (.jlpt-part, deeper yellow) are styled from the page's <head>.
const PAGE_CSS = parts => `${parts} { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none }
.jlpt-t { -webkit-tap-highlight-color: transparent }
.jlpt-sel { background: #fff3b0; touch-action: none }
.jlpt-part { background: #ffd54f }`;

const site = JLPT_NEWS.sites.find(s => s.origin === location.origin && new RegExp(s.path).test(location.pathname));
if (site) {
  configure({base: JLPT_NEWS.base, token: JLPT_NEWS.token, install: JLPT_NEWS.install});
  const {layer} = mountUi();
  let marker;
  const dock = mountDock(layer, {onRetokenize: () => marker.retokenize()});
  marker = new Marker(site, {onStatus: status => dock.setStatus(status)});
  mountWordCard(layer);
  mountReader(marker, () => marker.roots);
  // The page itself is left alone until `load` (see marks.mjs); the style goes in with the marks.
  const style = () => injectPageStyle(PAGE_CSS(site.parts.join(', ')));
  if (document.readyState === 'complete') style();
  else addEventListener('load', style, {once: true});
  marker.start();
  document.documentElement.dataset.jlptNews = 'ready';
}
