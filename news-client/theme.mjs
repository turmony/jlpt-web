// Light/dark theme of the script's own UI. By default ('auto') it follows the page: the background
// colour of <body> / <html> decides, re-checked when the page changes class or style or the system
// scheme flips. 'light' / 'dark' are manual choices (dock.mjs), remembered in localStorage.
// The result is `data-theme` on the layer, which ui.css turns into colours.

const KEY = 'jlpt-news-theme';
const MODES = ['auto', 'light', 'dark'];

export const normalizeMode = value => MODES.includes(value) ? value : 'auto';

// rgb()/rgba() as getComputedStyle returns them, comma or space separated -> {r, g, b, a}, else null.
export function parseColor(text) {
  const found = /^rgba?\(([^)]+)\)$/.exec(String(text || '').trim());
  if (!found) return null;
  const parts = found[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const [r, g, b] = parts.slice(0, 3).map(Number);
  let a = 1;
  if (parts[3] !== undefined) a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : Number(parts[3]);
  return [r, g, b, a].some(Number.isNaN) ? null : {r, g, b, a};
}

export const isDarkColor = ({r, g, b}) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;

export const resolveTheme = (mode, pageIsDark) => mode === 'auto' ? (pageIsDark ? 'dark' : 'light') : mode;

// Whether the page paints itself dark: the first opaque background from <body> up to <html>; a page
// that paints none shows the browser's canvas, which is dark only when it declares color-scheme: dark.
function pageIsDark() {
  for (const element of [document.body, document.documentElement]) {
    if (!element) continue;
    const color = parseColor(getComputedStyle(element).backgroundColor);
    if (color && color.a >= 0.5) return isDarkColor(color);
  }
  return /\bdark\b/.test(getComputedStyle(document.documentElement).colorScheme || '');
}

function readMode() {
  try { return normalizeMode(localStorage.getItem(KEY)); } catch { return 'auto'; }
}

let layer = null;
let mode = 'auto';
let frame = 0;
const listeners = new Set();

function apply() {
  frame = 0;
  if (!layer) return;
  layer.dataset.theme = resolveTheme(mode, mode === 'auto' && pageIsDark());
  layer.dataset.themeMode = mode;
}
const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };

export const getThemeMode = () => mode;

export function setThemeMode(next) {
  mode = normalizeMode(next);
  try { localStorage.setItem(KEY, mode); } catch { /* private window or blocked storage: lasts for this page only */ }
  apply();
  for (const listener of listeners) listener(mode);
}

export function onThemeMode(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// `into`: the shadow root's layer (ui.mjs).
export function mountTheme(into) {
  layer = into;
  mode = readMode();
  apply();
  const watch = {attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-bs-theme', 'data-color-mode', 'data-mode']};
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, watch);
  if (document.body) observer.observe(document.body, watch);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);
  // Stylesheets that arrive late change the background after the first reading.
  addEventListener('load', schedule);
  document.addEventListener('DOMContentLoaded', () => {
    if (document.body) observer.observe(document.body, watch);
    schedule();
  }, {once: true});
}
