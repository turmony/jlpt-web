import { selectCards, createSession, createTapHandler, adjacentRanges } from './core.mjs?v=range-shortcuts-2';
import { createImageLoader } from './image-loader.mjs';

const $ = id => document.getElementById(id);
const storageKey = 'jlpt-image-cards:last';
const rangeStorageKey = 'jlpt-image-cards:range-selection';
let catalog = null;
let session = null;
let activeRange = null;
let preloadGeneration = 0;
let saved = readSaved();
const savedSelection = readSelection();
let screen = 'setup';
const imageTimeouts = new WeakMap();
const imageUrls = new WeakMap();
const imageLoader = createImageLoader();
let cacheCleanupTimer;

function maintainImageCache() {
  void imageLoader.clearExpired();
  clearTimeout(cacheCleanupTimer);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  cacheCleanupTimer = setTimeout(maintainImageCache, midnight.getTime() - now.getTime() + 50);
}

function historyEntry() {
  return { screen, range: activeRange, id: session?.current.id, side: session?.side };
}

function readSaved() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey));
    return value && /^N[1-5]$/.test(value.level) && Number.isInteger(value.start) && Number.isInteger(value.end) ? value : null;
  } catch { return null; }
}

function readSelection() {
  try {
    const value = JSON.parse(localStorage.getItem(rangeStorageKey));
    return value && /^N[1-5]$/.test(value.level) && adjacentRanges(value.start, value.end) ? value : null;
  } catch { return null; }
}

function updateRangeShortcuts() {
  const range = currentInput();
  const neighbors = adjacentRanges(range.start, range.end);
  for (const side of ['previous', 'next']) {
    const button = $('quick-' + side);
    const numbers = neighbors?.[side];
    const label = side === 'previous' ? '前一区间' : '后一区间';
    button.textContent = numbers ? numbers.join('–') : label;
    button.disabled = !numbers;
    button.setAttribute('aria-label', numbers ? `填写${label} ${numbers[0]} 至 ${numbers[1]}` : `${label}暂不可用`);
  }
  // Invalid intermediate typing must not overwrite the last valid choice.
  if (!neighbors) return;
  try {
    localStorage.setItem(rangeStorageKey, JSON.stringify({
      level: range.level, start: Number(range.start), end: Number(range.end), ...neighbors,
    }));
  } catch { /* Quick fill still works when local storage is unavailable. */ }
}

function setError(id, message = '') {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function fillRange(range) {
  if (!range) return;
  const option = document.querySelector(`input[name="level"][value="${range.level}"]`);
  if (option) option.checked = true;
  $('start').value = range.start;
  $('end').value = range.end;
  updateRangeShortcuts();
}

function currentInput() {
  return { level: document.querySelector('input[name="level"]:checked').value,
    start: $('start').value, end: $('end').value };
}

function updateLevelSummary() {
  if (!catalog) return;
  const { level } = currentInput();
  const cards = catalog.cards.filter(c => c.level === level);
  const ready = cards.filter(c => c.images?.connection && c.images?.example).length;
  $('level-summary').textContent = ready ? `${level} · ${cards.length} 张语法卡，${ready} 张已配双图`
    : `${level} · ${cards.length} 张语法卡，暂未配齐课程双图`;
  setError('range-error');
}

async function loadCatalog() {
  $('start-reading').disabled = true;
  $('catalog-error').hidden = true;
  $('level-summary').textContent = '正在读取卡片目录…';
  try {
    const response = await fetch(new URL('./catalog.json', import.meta.url), {
      cache: 'no-cache', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('catalog unavailable');
    const value = await response.json();
    if (value.schema !== 1 || !Array.isArray(value.cards) || !value.cards.length) throw new Error('invalid catalog');
    catalog = value;
    $('start-reading').disabled = false;
    updateLevelSummary();
    if (saved) {
      try {
        selectCards(catalog, saved.level, saved.start, saved.end);
        $('resume-label').textContent = `${saved.id || saved.level} · ${saved.start}–${saved.end}`;
        $('resume').hidden = false;
      } catch { $('resume').hidden = true; }
    }
    if (history.state?.screen !== 'setup') restoreHistory(history.state);
  } catch {
    $('level-summary').textContent = '暂时无法读取卡片目录';
    $('catalog-error').hidden = false;
  }
}

function remember() {
  saved = { ...activeRange, id: session.current.id };
  try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* Reading works without storage. */ }
  $('resume-label').textContent = `${saved.id} · ${saved.start}–${saved.end}`;
  $('resume').hidden = false;
  if (screen !== 'setup') history.replaceState(historyEntry(), '');
}

function displayImage(imageId, statusId, retryId, url, description, retry = false) {
  const img = $(imageId);
  const status = $(statusId);
  if (!retry && img.dataset.source === url) return;
  clearTimeout(imageTimeouts.get(img));
  img.onload = img.onerror = null;
  img.removeAttribute('src');
  if (imageUrls.has(img)) { URL.revokeObjectURL(imageUrls.get(img)); imageUrls.delete(img); }
  img.dataset.source = url;
  const token = String(Number(img.dataset.token || 0) + 1);
  img.dataset.token = token;
  img.hidden = true;
  img.alt = description;
  status.hidden = false;
  status.textContent = '正在加载图片…';
  $(retryId).hidden = true;
  let expired = false;
  const fail = message => {
    if (img.dataset.token !== token) return;
    expired = true;
    clearTimeout(imageTimeouts.get(img));
    img.onload = img.onerror = null;
    img.removeAttribute('src');
    img.hidden = true;
    status.hidden = false;
    status.textContent = message;
    $(retryId).hidden = false;
  };
  const timeout = setTimeout(() => fail('图片加载超时，请重试。'), 20000);
  imageTimeouts.set(img, timeout);
  img.onload = () => {
    if (img.dataset.token !== token) return;
    clearTimeout(timeout);
    img.hidden = false;
    status.hidden = true;
    $(retryId).hidden = true;
  };
  img.onerror = () => {
    fail('图片加载失败，请检查网络后重试。');
  };
  imageLoader.load(url, catalog.revision, { retry }).then(blob => {
    if (expired || img.dataset.token !== token) return;
    const source = URL.createObjectURL(blob);
    imageUrls.set(img, source);
    img.src = source;
  }).catch(error => fail(error.name === 'AbortError' ? '图片加载超时，请重试。' : '图片加载失败，请检查网络后重试。'));
}

function renderFull(retry = false) {
  if (!session) return;
  const card = session.current;
  const side = session.side === 'connection' ? '接续' : '例句';
  $('lightbox-title').textContent = `${card.id} · ${side}`;
  $('lightbox-progress').textContent = `${session.index + 1} / ${session.cards.length} · ${activeRange.level} ${activeRange.start}–${activeRange.end}`;
  $('toggle-image').textContent = session.side === 'connection' ? '看例句' : '看接续';
  $('full-previous').disabled = session.index === 0;
  $('full-next').disabled = session.index === session.cards.length - 1;
  displayImage('full-image', 'full-status', 'retry-full', card.images[session.side], `${card.id} ${card.title} ${side}图`, retry);
  if (screen === 'lightbox') history.replaceState(historyEntry(), '');
}

function renderCard() {
  const card = session.current;
  $('card-id').textContent = card.id;
  $('card-title').textContent = card.title;
  $('card-progress').textContent = `${session.index + 1} / ${session.cards.length}`;
  $('range-label').textContent = `${activeRange.level} · ${activeRange.start}–${activeRange.end}`;
  $('progress-fill').style.width = `${(session.index + 1) / session.cards.length * 100}%`;
  $('previous').disabled = session.index === 0;
  $('next').disabled = session.index === session.cards.length - 1;
  displayImage('thumbnail-image', 'thumbnail-status', 'retry-thumbnail', card.images.connection, `${card.id} ${card.title} 接续图`);
  setError('jump-error');
  remember();
  if ($('lightbox').open) renderFull();
}

function move(delta) {
  taps.cancel();
  session.move(delta);
  renderCard();
}

function toggleImage() {
  taps.cancel();
  session.toggle();
  renderFull();
}

function preloadRange(cards) {
  const generation = ++preloadGeneration;
  const urls = cards.flatMap(c => [c.images.connection, c.images.example]);
  let cursor = 0;
  async function next() {
    while (generation === preloadGeneration && cursor < urls.length) {
      try { await imageLoader.load(urls[cursor++], catalog.revision, { priority: 'low' }); }
      catch { /* Foreground viewing provides the retry control. */ }
    }
  }
  void next();
  void next();
}

function begin(range, id) {
  try {
    const cards = selectCards(catalog, range.level, range.start, range.end);
    activeRange = { level: range.level, start: Number(range.start), end: Number(range.end) };
    session = createSession(cards, id);
    screen = 'reader';
    history.pushState(historyEntry(), '', `#${activeRange.level}/${activeRange.start}-${activeRange.end}`);
    $('setup').hidden = true;
    $('reader').hidden = false;
    renderCard();
    window.scrollTo(0, 0);
    $('change-range').focus({ preventScroll: true });
    preloadRange(cards);
  } catch (error) {
    setError('range-error', error.message);
    $('start').focus();
  }
}

function showSetup() {
  screen = 'setup';
  taps.cancel();
  ++preloadGeneration;
  if ($('lightbox').open) $('lightbox').close();
  $('reader').hidden = true;
  $('setup').hidden = false;
  fillRange(activeRange);
  updateLevelSummary();
  window.scrollTo(0, 0);
}

function closeLightbox() {
  taps.cancel();
  if (history.state?.screen === 'lightbox') history.back();
  else $('lightbox').close();
}

const taps = createTapHandler({
  single: delta => { if ($('lightbox').open) move(delta); },
  double: () => { if ($('lightbox').open) toggleImage(); },
});

// A tap must remain stationary. Scrolls, pinch gestures and pointer cancellation
// cancel both the current gesture and any delayed navigation.
const activePointers = new Set();
let pointer = null;
const stage = $('image-stage');
stage.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  activePointers.add(event.pointerId);
  if (activePointers.size > 1 || !event.isPrimary) {
    pointer = null;
    taps.cancel();
    return;
  }
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() };
  taps.start({ x: event.clientX, y: event.clientY });
});
stage.addEventListener('pointermove', event => {
  if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 12) {
    pointer = null;
    taps.cancel();
  }
});
window.addEventListener('pointerup', event => {
  activePointers.delete(event.pointerId);
  const start = pointer;
  if (!start || start.id !== event.pointerId) return;
  pointer = null;
  if (!stage.contains(event.target) || performance.now() - start.time > 500
      || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) {
    taps.cancel();
    return;
  }
  // At browser zoom >1, touches are used for panning the magnified image.
  if ((window.visualViewport?.scale || 1) > 1.05) { taps.cancel(); return; }
  const bounds = stage.getBoundingClientRect();
  taps.tap(event.clientX - bounds.left < bounds.width * .18 ? -1 : 1,
    { x: event.clientX, y: event.clientY });
});
window.addEventListener('pointercancel', event => {
  activePointers.delete(event.pointerId);
  pointer = null;
  taps.cancel();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) taps.cancel();
  else maintainImageCache();
});
window.addEventListener('pageshow', maintainImageCache);

$('range-form').addEventListener('submit', event => {
  event.preventDefault();
  const range = currentInput();
  const matchesSaved = saved && saved.level === range.level && saved.start === Number(range.start) && saved.end === Number(range.end);
  begin(range, matchesSaved ? saved.id : undefined);
});
$('range-form').addEventListener('input', () => { setError('range-error'); updateRangeShortcuts(); });
document.querySelectorAll('input[name="level"]').forEach(input => input.addEventListener('change', updateLevelSummary));
for (const side of ['previous', 'next']) {
  $('quick-' + side).addEventListener('click', () => {
    const range = currentInput();
    const numbers = adjacentRanges(range.start, range.end)?.[side];
    if (!numbers) return;
    fillRange({ level: range.level, start: numbers[0], end: numbers[1] });
    setError('range-error');
  });
}
$('resume').addEventListener('click', () => { fillRange(saved); begin(saved, saved.id); });
$('reload-catalog').addEventListener('click', loadCatalog);
$('change-range').addEventListener('click', () => {
  if (history.state?.screen === 'reader') history.back();
  else showSetup();
});
$('previous').addEventListener('click', () => move(-1));
$('next').addEventListener('click', () => move(1));
$('full-previous').addEventListener('click', () => move(-1));
$('full-next').addEventListener('click', () => move(1));
$('toggle-image').addEventListener('click', toggleImage);
$('thumbnail').addEventListener('click', () => {
  session.side === 'example' && session.toggle();
  $('lightbox').showModal();
  screen = 'lightbox';
  history.pushState(historyEntry(), '', `#${activeRange.level}/${activeRange.start}-${activeRange.end}/image`);
  renderFull();
});
$('retry-thumbnail').addEventListener('click', () => displayImage('thumbnail-image', 'thumbnail-status', 'retry-thumbnail', session.current.images.connection, `${session.current.id} 接续图`, true));
$('retry-full').addEventListener('click', () => renderFull(true));
$('close-lightbox').addEventListener('click', closeLightbox);
$('lightbox').addEventListener('cancel', event => { event.preventDefault(); closeLightbox(); });
$('lightbox').addEventListener('close', () => { taps.cancel(); activePointers.clear(); pointer = null; });
$('jump-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    taps.cancel();
    session.jump($('jump').value);
    renderCard();
    $('jump').value = '';
  } catch (error) { setError('jump-error', error.message); }
});
document.addEventListener('keydown', event => {
  if (!session || $('reader').hidden || /INPUT|TEXTAREA/.test(event.target.tagName)) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
  if ($('lightbox').open && (event.key === ' ' || event.key === 'Enter') && event.target === stage) {
    event.preventDefault(); toggleImage();
  }
});
function restoreHistory(state) {
  taps.cancel();
  if (!catalog || !state?.range || state.screen === 'setup') { showSetup(); return; }
  const sameRange = activeRange && ['level', 'start', 'end'].every(key => state.range[key] === activeRange[key]);
  const closingImage = screen === 'lightbox' && state.screen === 'reader' && sameRange;
  try {
    if (!closingImage) {
      session = createSession(selectCards(catalog, state.range.level, state.range.start, state.range.end), state.id);
      activeRange = state.range;
      if (state.side === 'example') session.toggle();
      preloadRange(session.cards);
    }
    screen = state.screen;
    $('setup').hidden = true;
    $('reader').hidden = false;
    if (screen === 'lightbox') {
      if (!$('lightbox').open) $('lightbox').showModal();
    } else if ($('lightbox').open) $('lightbox').close();
    renderCard();
  } catch (error) {
    showSetup();
    setError('range-error', error.message);
  }
}
window.addEventListener('popstate', event => restoreHistory(event.state));

const match = location.hash.match(/^#(N[1-5])\/(\d+)-(\d+)/);
fillRange(match ? { level: match[1], start: match[2], end: match[3] } : savedSelection || saved);
updateRangeShortcuts();
history.replaceState({ screen: 'setup' }, '');
maintainImageCache();
loadCatalog();
