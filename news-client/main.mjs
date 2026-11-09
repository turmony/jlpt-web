// Entry point of the main script. The userscript loader runs the bundle with the free variable
// JLPT_NEWS = {base, token, sites, install}.
import {configure} from './api.mjs';
import {mountUi, injectPageStyle} from './ui.mjs';
import {mountDock} from './dock.mjs';
import {Marker} from './marks.mjs';

const site = JLPT_NEWS.sites.find(s => s.origin === location.origin && new RegExp(s.path).test(location.pathname));
if (site) {
  configure({base: JLPT_NEWS.base, token: JLPT_NEWS.token, install: JLPT_NEWS.install});
  const {layer} = mountUi();
  let marker;
  const dock = mountDock(layer, {onRetokenize: () => marker.retokenize()});
  marker = new Marker(site, {onStatus: status => dock.setStatus(status)});
  // The page itself is left alone until `load` (see marks.mjs); the style goes in with the marks.
  const style = () => injectPageStyle(`${site.parts.join(', ')} { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none }`);
  if (document.readyState === 'complete') style();
  else addEventListener('load', style, {once: true});
  marker.start();
  document.documentElement.dataset.jlptNews = 'ready';
}
