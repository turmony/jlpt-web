// The loupe shown while a part is being selected by long press and drag (reader.mjs): the finger
// hides the words it is on, so a bubble re-sets the text around the word under the finger in larger
// type. It is plain text built from the sentence's own words, not a magnified picture, so the news
// site's CSS and re-renders do not touch it. Words keep a thin gap between them (selection snaps to
// whole words, the page shows no word boundaries), and carry the same colours as the page:
// pale for the sentence, deeper for the selected part, bold and underlined for the word under the finger.
//
// Position: above the first line of the selected part (the finger is usually at its end, below).
// When that line is off the screen or more than FAR px above the finger, above the finger's line
// instead; when there is no room above either, below the part with a finger's height to spare.
// A hint line under the text says that lifting the finger away from the sentence cancels; once the finger is
// that far (cancel), the bubble turns red and says so. It follows the finger horizontally and never takes a touch.

const MARGIN = 8;
const GAP = 8;
const FAR = 200;
const FINGER = 48;
const MAX_WORDS = 60;

let layer = null;
let box = null;      // {root, text, hint}
let shown = null;    // {found, focus, from, to}: what the bubble text holds now

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// `into`: the shadow root's layer (ui.mjs) the bubble is put in.
export function mountLoupe(into) {
  layer = into;
}

export function hideLoupe() {
  box?.root.remove();
  box = null;
  shown = null;
}

function ensure() {
  if (box) return box;
  const root = node('div', 'news-loupe');
  root.setAttribute('aria-hidden', 'true');
  root.lang = 'ja';
  const text = node('div', 'news-loupe-text');
  const hint = node('div', 'news-loupe-hint');
  hint.lang = 'zh-CN';
  root.append(text, hint);
  layer.append(root);
  return box = {root, text, hint};
}

function word(token, index) {
  const element = node('span', 'news-loupe-word', token.s);
  element.dataset.i = String(index);
  return element;
}

// Fills the bubble with as many words around `focus` as fit on one line, alternately to the right and
// the left, and marks with … that more text goes on at a side.
function fill(found, focus) {
  const {text, root} = ensure();
  const {tokens} = found;
  text.replaceChildren(word(tokens[focus], focus));
  let from = focus;
  let to = focus;
  const more = () => {
    text.dataset.left = String(from > 0);
    text.dataset.right = String(to < tokens.length - 1);
  };
  const overflows = () => text.scrollWidth > text.clientWidth;
  more();
  root.hidden = false;
  for (let turn = 0; to - from + 1 < MAX_WORDS && (from > 0 || to < tokens.length - 1); turn++) {
    const right = (turn % 2 === 0 && to < tokens.length - 1) || from === 0;
    const added = right ? word(tokens[++to], to) : word(tokens[--from], from);
    if (right) text.append(added); else text.prepend(added);
    more();
    if (overflows()) {
      added.remove();
      if (right) to--; else from++;
      more();
      break;
    }
  }
  shown = {found, focus, from, to};
}

// The classes that carry the selection: the whole sentence pale, the selected part deeper, the word
// under the finger bold.
function paint(start, end, focus) {
  for (const element of box.text.children) {
    const index = Number(element.dataset.i);
    element.classList.toggle('part', start != null && index >= start && index <= end);
    element.classList.toggle('focus', index === focus);
  }
}

// The first and the last line box of a word's pieces on the page, or null when it is not there.
function lineOf(pieces, last) {
  const live = (pieces || []).filter(span => span.isConnected);
  const piece = last ? live.at(-1) : live[0];
  const rects = piece ? piece.getClientRects() : [];
  return rects.length ? (last ? rects[rects.length - 1] : rects[0]) : null;
}

function place(found, start, end, focus, x) {
  const {root} = box;
  const width = root.offsetWidth;
  const height = root.offsetHeight;
  const viewWidth = document.documentElement.clientWidth;
  const viewHeight = window.innerHeight;
  const spans = found.spans;
  const first = lineOf(spans[start ?? 0], false);
  const last = lineOf(spans[end ?? spans.length - 1], true);
  const finger = lineOf(spans[focus], false);
  let top = MARGIN;
  if (first) top = first.top - GAP - height;
  if (finger && (!first || first.top < 0 || finger.top - first.top > FAR)) top = finger.top - GAP - height;
  if (top < MARGIN && (last || finger)) top = (last || finger).bottom + FINGER;
  top = Math.max(MARGIN, Math.min(top, viewHeight - MARGIN - height));
  const left = Math.max(MARGIN, Math.min(x - width / 2, viewWidth - MARGIN - width));
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
}

// Shows or updates the bubble. `found` is the marked sentence ({tokens, spans}), start/end the selected
// part (both null while the whole sentence is held), focus the index of the word under the finger, x the
// finger's viewport x and cancel whether lifting the finger now would cancel the selection.
export function showLoupe(found, {start, end, focus, x, cancel = false}) {
  if (!layer || !found || !found.tokens[focus]) return hideLoupe();
  if (!box || !shown || shown.found !== found || shown.focus !== focus) fill(found, focus);
  paint(start, end, focus);
  box.root.classList.toggle('cancel', cancel);
  box.hint.textContent = cancel ? '松手取消' : '拖离句子后松手可取消';
  place(found, start, end, focus, x);
}
