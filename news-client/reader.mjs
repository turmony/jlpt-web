// Gestures on the words marks.mjs wrapped on the news page, and the selected sentence.
// Pointer Events, so touch, pen and mouse behave alike:
//   tap a word                          -> word card (wordcard.mjs); punctuation and digits do nothing
//   press 500 ms anywhere in a sentence -> the sentence is highlighted; nothing is analysed yet
//     release without moving            -> fires jlpt:select-sentence {sentenceId}
//     keep the finger down and drag     -> a part from the pressed word to the word under the finger (whole
//                                          words, clamped to that sentence); on release fires
//                                          jlpt:select-part {sentenceId, start, end}
//   drag on an already selected sentence (a new touch) -> the same part selection, from the touched word
//   drag anywhere else                  -> the page scrolls as usual
// While a part is being selected after a long press, a loupe (loupe.mjs) shows the text around the word
// under the finger. Moving more than 10 px before the 500 ms are up cancels the press. Both events are CustomEvents on document; this module
// listens to them as well (whoever fires them) and keeps the highlight in step: every piece of the
// selected sentence gets .jlpt-sel, the pieces of the selected part's words .jlpt-part (a word cut
// by inline elements has several pieces). After a re-render the new pieces are painted again.
import {hideLoupe, showLoupe} from './loupe.mjs';
import {anchorWordCard, closeWordCard, showWordCard} from './wordcard.mjs';

export const LONG_PRESS_MS = 500;
export const MOVE_TOLERANCE_PX = 10;

let marker = null;
let roots = () => [];
let selection = null; // {sentenceId, start, end}; start/end null when the whole sentence is selected
let press = null;     // {pointerId, x, y, el, sentenceId, index, inSelected, mode, timer}; mode is pending, held (long press fired,
                      // finger still down), drag or none

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
  hideLoupe();
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
    // Only the highlight: whether this is the whole sentence or a part is decided when the finger lifts.
    state.mode = 'held';
    closeWordCard();
    highlight(sentenceId, null, null);
    showLoupe(marker.sentence(sentenceId), {start: null, end: null, focus: state.index, x: state.x});
  }, LONG_PRESS_MS);
}

function onPointerMove(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  if (event.pointerType === 'mouse' && event.buttons === 0) return onPointerCancel(event); // the release was missed
  const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE_PX;
  if (press.mode === 'pending' && moved) {
    clearTimeout(press.timer);
    press.mode = press.inSelected && selection?.sentenceId === press.sentenceId ? 'drag' : 'none';
    if (press.mode === 'drag') closeWordCard();
  } else if (press.mode === 'held' && moved) {
    press.mode = 'drag'; // after the long press the same touch goes on selecting a part
    press.held = true;
  }
  if (press.mode !== 'drag') return;
  event.preventDefault();
  const index = indexAt(press.sentenceId, event.clientX, event.clientY);
  const [low, high] = [Math.min(press.index, index), Math.max(press.index, index)];
  highlight(press.sentenceId, low, high);
  showLoupe(marker.sentence(press.sentenceId), {start: low, end: high, focus: index, x: event.clientX});
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
    else if (state.held) fire('jlpt:select-sentence', {sentenceId: state.sentenceId}); // punctuation only: the whole sentence
    else paint();
  } else if (state.mode === 'held') {
    fire('jlpt:select-sentence', {sentenceId: state.sentenceId});
  }
}

function onPointerCancel(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  const highlighted = press.mode === 'drag' || press.mode === 'held';
  endPress();
  if (highlighted) paint();
}

// `roots()` gives the article parts now on the page (they may be replaced by a re-render).
// Listeners sit on the document, so parts that come and go keep working.
export function mountReader(theMarker, getRoots) {
  marker = theMarker;
  roots = getRoots;
  marker.onRewrap(() => {
    paint();
    anchorWordCard();
  });
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
  document.addEventListener('touchmove', event => {
    const holding = press?.mode === 'held' || (press?.mode === 'drag' && press.held);
    if ((touchOnSelected || holding) && event.cancelable) event.preventDefault();
  }, {passive: false});
}
