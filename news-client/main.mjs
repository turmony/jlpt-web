// Entry point of the main script. The userscript loader runs the bundle with the free variable
// JLPT_NEWS = {base, token, sites, install}.
import {configure} from './api.mjs';
import {mountUi} from './ui.mjs';

const site = JLPT_NEWS.sites.find(s => s.origin === location.origin && new RegExp(s.path).test(location.pathname));
if (site) {
  configure({base: JLPT_NEWS.base, token: JLPT_NEWS.token, install: JLPT_NEWS.install});
  mountUi();
  document.documentElement.dataset.jlptNews = 'ready';
}
