// Gestures on the words marks.mjs wrapped on the news page, and the selected sentence.
// Pointer Events, so touch, pen and mouse behave alike:
//   tap a word                          -> word card (wordcard.mjs); punctuation and digits do nothing
//   press 500 ms anywhere in a sentence -> fires jlpt:select-sentence {sentenceId}
//   drag on the selected sentence       -> whole words, clamped to that sentence; on release fires
//                                          jlpt:select-part {sentenceId, start, end}
//   drag anywhere else                  -> the page scrolls as usual
// Moving more than 10 px cancels a press. Both events are CustomEvents on document; this module
// listens to them as well (whoever fires them) and keeps the highlight in step: every piece of the
// selected sentence gets .jlpt-sel, the pieces of the selected part's words .jlpt-part (a word cut
// by inline elements has several pieces). After a re-render the new pieces are painted again.
import {closeWordCard, showWordCard} from './wordcard.mjs';

export const LONG_PRESS_MS = 500;
export const MOVE_TOLERANCE_PX = 10;

let marker = null;
let roots = () => [];
let selection = null; // {sentenceId, start, end}; start/end null when the whole sentence is selected
let press = null;     // {pointerId, x, y, el, sentenceId, index, inSelected, mode, timer}

// {sentenceId, start, end} (start/end null for the whole sentence), or null.
export function currentSelection() {
  return selection && marker?.sentence(selection.sentenceId) ? {...selection} : null;
}

// Removes the highlight; fires nothing.
export function clearSelection() {
  selection = null;
  paint();
}

// ---- Selection state ----
function highlight(sentenceId, start, end) {
  for (const element of document.querySelectorAll('.jlpt-sel')) element.classList.remove('jlpt-sel');
  for (const element of document.querySelectorAll('.jlpt-part')) element.classList.remove('jlpt-part');
  const found = sentenceId == null ? null : marker.sentence(sentenceId);
  if (!found) return;
  found.spans.forEach((pieces, index) => {
    const part = start != null && index >= start && index <= end;
    for (const span of pieces) {
      span.classList.add('jlpt-sel');
      if (part) span.classList.add('jlpt-part');
    }
  });
}

function paint() {
  if (selection) highlight(selection.sentenceId, selection.start, selection.end);
  else highlight(null);
}

const fire = (name, detail) => document.dispatchEvent(new CustomEvent(name, {detail}));

function onSelectSentence(event) {
  const id = event.detail?.sentenceId;
  if (!marker.sentence(id)) return;
  selection = {sentenceId: id, start: null, end: null};
  paint();
}

function onSelectPart(event) {
  const {sentenceId, start, end} = event.detail || {};
  const found = marker.sentence(sentenceId);
  if (!found || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end >= found.tokens.length) return;
  selection = {sentenceId, start, end};
  paint();
}

// ---- Gestures ----
const elementOf = target => target instanceof Element ? target : target?.parentElement || null;
const inRoots = target => {
  const el = elementOf(target);
  return !!el && roots().some(root => root.contains(el));
};
// The marked piece under `target`, if it is inside one of the parts.
function tokenOf(target) {
  const el = elementOf(target)?.closest('.jlpt-t');
  return el && inRoots(el) ? el : null;
}

// Whether `el` comes before the first piece of sentence `found` on the page.
function before(el, found) {
  const first = found.spans.flat().find(span => span.isConnected);
  return !!first && !!(el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING);
}

// The word of `sentenceId` under (x, y), clamped to that sentence: a point in an earlier sentence
// (or above it) gives the first word, a later one the last; elsewhere the last word that starts at
// or before the point in reading order. All pieces of a word count.
function indexAt(sentenceId, x, y) {
  const found = marker.sentence(sentenceId);
  const hit = tokenOf(document.elementFromPoint(x, y));
  if (hit) {
    const id = Number(hit.dataset.s);
    if (id === sentenceId) return Number(hit.dataset.i);
    if (marker.sentence(id)) return before(hit, found) ? 0 : found.tokens.length - 1;
  }
  let index = 0;
  found.spans.forEach((pieces, position) => {
    for (const span of pieces) {
      for (const rect of span.getClientRects()) {
        if (y > rect.bottom || (y >= rect.top && x >= rect.left)) index = position;
      }
    }
  });
  return index;
}

// Leading and trailing punctuation and spaces are dropped (numbers stay: 10日 is a unit); a range of
// punctuation only is no selection.
const EDGE_POS = new Set(['補助記号', '記号', '空白']);
function trimmed(sentenceId, start, end) {
  const {tokens} = marker.sentence(sentenceId);
  const edge = token => EDGE_POS.has(token.p) || !token.s.trim();
  while (start <= end && edge(tokens[start])) start++;
  while (end >= start && edge(tokens[end])) end--;
  return start <= end ? [start, end] : null;
}

function endPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function onPointerDown(event) {
  if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
  endPress();
  const el = tokenOf(event.target);
  if (!el) return;
  const sentenceId = Number(el.dataset.s);
  if (!marker.sentence(sentenceId)) return;
  const state = press = {
    pointerId: event.pointerId, x: event.clientX, y: event.clientY, el, sentenceId, index: Number(el.dataset.i),
    inSelected: selection?.sentenceId === sentenceId, mode: 'pending', timer: 0,
  };
  state.timer = setTimeout(() => {
    if (press !== state || state.mode !== 'pending') return;
    state.mode = 'done';
    closeWordCard();
    fire('jlpt:select-sentence', {sentenceId});
  }, LONG_PRESS_MS);
}

function onPointerMove(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  if (event.pointerType === 'mouse' && event.buttons === 0) return onPointerCancel(event); // the release was missed
  if (press.mode === 'pending' && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE_PX) {
    clearTimeout(press.timer);
    press.mode = press.inSelected && selection?.sentenceId === press.sentenceId ? 'drag' : 'none';
    if (press.mode === 'drag') closeWordCard();
  }
  if (press.mode !== 'drag') return;
  event.preventDefault();
  const index = indexAt(press.sentenceId, event.clientX, event.clientY);
  highlight(press.sentenceId, Math.min(press.index, index), Math.max(press.index, index));
}

function onPointerUp(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  const state = press;
  endPress();
  const found = marker.sentence(state.sentenceId);
  if (!found) return;
  if (state.mode === 'pending') {
    // A re-render between press and release replaced the piece: use the word's new one.
    const el = state.el.isConnected ? state.el : found.spans[state.index]?.find(span => span.isConnected);
    if (!el || !el.classList.contains('jlpt-word')) return;
    showWordCard(el, found.tokens[state.index], state.sentenceId, state.index);
  } else if (state.mode === 'drag') {
    const index = indexAt(state.sentenceId, event.clientX, event.clientY);
    const range = trimmed(state.sentenceId, Math.min(state.index, index), Math.max(state.index, index));
    if (range) fire('jlpt:select-part', {sentenceId: state.sentenceId, start: range[0], end: range[1]});
    else paint();
  }
}

function onPointerCancel(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  const dragging = press.mode === 'drag';
  endPress();
  if (dragging) paint();
}

// `roots()` gives the article parts now on the page (they may be replaced by a re-render).
// Listeners sit on the document, so parts that come and go keep working.
export function mountReader(theMarker, getRoots) {
  marker = theMarker;
  roots = getRoots;
  marker.onRewrap(() => paint());
  document.addEventListener('jlpt:select-sentence', onSelectSentence);
  document.addEventListener('jlpt:select-part', onSelectPart);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
  // A word inside a link is looked up, not followed; the rest of the link still works. Capture on
  // window runs before the site's own handlers.
  window.addEventListener('click', event => { if (tokenOf(event.target)) event.preventDefault(); }, true);
  // No system menu, text selection or loupe on the parts; panning is blocked only when a touch
  // starts on the selected sentence (touch-action on inline pieces is not enough for WebKit).
  document.addEventListener('contextmenu', event => { if (inRoots(event.target)) event.preventDefault(); });
  document.addEventListener('selectstart', event => { if (inRoots(event.target)) event.preventDefault(); });
  let touchOnSelected = false;
  document.addEventListener('touchstart', event => {
    const el = tokenOf(event.target);
    touchOnSelected = !!el && selection?.sentenceId === Number(el.dataset.s);
  }, {passive: true});
  document.addEventListener('touchmove', event => { if (touchOnSelected && event.cancelable) event.preventDefault(); }, {passive: false});
}
