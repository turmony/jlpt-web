// The script's own DOM: one <jlpt-news> element under <html> with a shadow root, isolated from the
// news site's CSS in both directions.
import css from './ui.css';

// -> {host, root, layer}: `layer` is the fixed full-screen container for floating UI.
export function mountUi() {
  const host = document.createElement('jlpt-news');
  host.style.cssText = 'all: initial';
  const root = host.attachShadow({mode: 'open'});
  const style = document.createElement('style');
  style.textContent = css;
  const layer = document.createElement('div');
  layer.className = 'layer';
  root.append(style, layer);
  document.documentElement.append(host);
  return {host, root, layer};
}

// Styles that must reach the article itself (e.g. marked words) go into the page's <head>.
export function injectPageStyle(cssText) {
  const style = document.createElement('style');
  style.dataset.jlptNews = '';
  style.textContent = cssText;
  document.head.append(style);
  return style;
}
