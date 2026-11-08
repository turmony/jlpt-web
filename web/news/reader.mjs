import {errorLine, progressLine, streamSSE} from '/news/api.mjs';
import {mountHeader} from '/news/header.mjs';
import {closeWordCard, showWordCard} from '/news/wordcard.mjs';

// The reader page: opens the Yahoo article named by ?url= and shows it word by word.
// Every token is <span class="news-token" data-s="{sentence id}" data-i="{token index}">, inside
// <span class="news-sentence" data-sid="{sentence id}">; tappable tokens also have class news-word.
//
// Gestures (Pointer Events, so touch, pen and mouse behave alike):
//   tap a word                         -> word card (wordcard.mjs); punctuation and digits do nothing
//   press 500 ms anywhere in a sentence -> fires news:select-sentence {sentenceId}
//   drag on the selected sentence       -> whole tokens, clamped to that sentence; on release fires
//                                          news:select-part {sentenceId, start, end}
//   drag anywhere else                  -> the page scrolls as usual
// Moving more than 10 px cancels a press. Both events are CustomEvents on document; this module
// listens to them as well (whoever fires them) and keeps the highlight in step: the selected
// sentence gets .is-selected, the selected part's tokens .is-part. After each article render it
// fires news:article {articleId} on document.
export const LONG_PRESS_MS = 500;
export const MOVE_TOLERANCE_PX = 10;

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');

let article = null;
const sentences = new Map(); // id -> {id, tokens, el}
let selection = null;        // {sentenceId, start, end}; start/end null when the whole sentence is selected
let opening = null;          // AbortController of the open in progress

// ---- For the analysis panel (Task 10) ----
export function currentArticle() { return article; }
// {id, tokens, text} of a rendered sentence, or null.
export function sentenceById(id) {
  const found = sentences.get(id);
  return found ? {id, tokens: found.tokens, text: found.tokens.map(token => token.s).join('')} : null;
}
// {articleId, sentenceId, start, end} (start/end null for the whole sentence), or null.
export function currentSelection() {
  return selection && article ? {articleId: article.id, ...selection} : null;
}
// Removes the highlight; fires nothing.
export function clearSelection() {
  selection = null;
  paint();
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Links come from Yahoo's page data: only https on news.yahoo.co.jp or *.yahoo.co.jp is kept.
function yahooLink(href) {
  try {
    const parsed = new URL(href);
    if (parsed.protocol === 'https:' && (parsed.hostname === 'news.yahoo.co.jp' || parsed.hostname.endsWith('.yahoo.co.jp'))) return parsed.href;
  } catch {}
  return null;
}

// `href` when it is a Yahoo link, else the article's own address (validated by the server).
function outLink(href, text) {
  const link = node('a', '', text);
  link.href = yahooLink(href) || article.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function clientInfo(reason, retryable = true) {
  const now = new Date();
  return {stage: 'client', stage_label: '网页→服务器', location: '', reason, retryable, request_id: '',
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`};
}

function published(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---- Rendering ----
function sentenceNodes(list) {
  return (list || []).map(sentence => {
    const span = node('span', 'news-sentence');
    span.dataset.sid = sentence.id;
    sentence.tokens.forEach((token, index) => {
      const piece = node('span', token.t ? 'news-token news-word' : 'news-token', token.s);
      piece.dataset.s = sentence.id;
      piece.dataset.i = index;
      span.append(piece);
    });
    sentences.set(sentence.id, {id: sentence.id, tokens: sentence.tokens, el: span});
    return span;
  });
}

const textOf = list => (list || []).map(sentence => sentence.tokens.map(token => token.s).join('')).join('');
// `key` names the image's content: after a 重试 refills a missing page, index n can be another
// picture, and the browser keeps /api/news/image/<id>/<n> for 7 days.
const imageUrl = (index, key) => `/api/news/image/${encodeURIComponent(article.id)}/${index}${key ? `?v=${encodeURIComponent(key)}` : ''}`;

function picture(src, alt, onFail) {
  const img = node('img');
  img.src = src;
  img.alt = alt;
  img.decoding = 'async';
  img.addEventListener('error', () => img.replaceWith(onFail()), {once: true});
  return img;
}

// Image errors carry 「第 N 张」, N = image index + 1. Article images keep their index even when they
// failed; a video poster that failed loses its index (cover null), so it is found from the gap it
// leaves between the neighbouring known indices. Everything else goes after the content.
function placeErrors(blocks, errors) {
  const known = blocks.map(block => block.type === 'image' ? block.index : block.type === 'video' && block.cover != null ? block.cover : null);
  const byImage = new Map();
  for (const info of errors) {
    const match = info.stage === 'image' && /^第 (\d+) 张$/.exec(info.location || '');
    if (match && !byImage.has(Number(match[1]) - 1)) byImage.set(Number(match[1]) - 1, info);
  }
  const at = new Map(); // block position -> error info
  blocks.forEach((block, position) => {
    if (block.type === 'image' && !block.ok && byImage.has(block.index)) at.set(position, byImage.get(block.index));
  });
  blocks.forEach((block, position) => {
    if (block.type !== 'video' || block.cover != null) return;
    const before = Math.max(-1, ...known.slice(0, position).filter(value => value != null));
    const after = Math.min(Infinity, ...known.slice(position + 1).filter(value => value != null));
    const used = new Set(at.values());
    const hit = [...byImage.keys()].sort((a, b) => a - b)
      .find(index => index > before && index < after && !known.includes(index) && !used.has(byImage.get(index)));
    if (hit !== undefined) at.set(position, byImage.get(hit));
  });
  const placed = new Set(at.values());
  return {at, rest: errors.filter(info => !placed.has(info))};
}

function blockNode(block, error) {
  const problem = error ? [errorLine(error, open)] : [];
  if (block.type === 'heading' || block.type === 'paragraph') {
    const element = node(block.type === 'heading' ? 'h3' : 'p', block.type === 'heading' ? 'news-heading' : 'news-para');
    element.append(...sentenceNodes(block.sentences));
    return element;
  }
  if (block.type === 'image') {
    const figure = node('figure', 'news-figure');
    const missing = () => node('div', 'news-image-missing', '图片没能显示');
    figure.append(block.ok ? picture(imageUrl(block.index, block.key), textOf(block.caption_sentences), missing) : missing(), ...problem);
    if ((block.caption_sentences || []).length || block.credit) {
      const caption = node('figcaption');
      caption.append(...sentenceNodes(block.caption_sentences));
      if (block.credit) caption.append(node('span', 'news-credit', block.credit));
      figure.append(caption);
    }
    return figure;
  }
  if (block.type === 'video') {
    const figure = node('figure', 'news-video');
    const placeholder = () => node('div', 'news-video-placeholder', '视频');
    figure.append(block.cover != null ? picture(imageUrl(block.cover, block.cover_key), '视频封面', placeholder) : placeholder(), ...problem);
    const caption = node('figcaption');
    caption.append(outLink(block.url || article.url, '在雅虎观看'));
    figure.append(caption);
    return figure;
  }
  const unknown = node('p', 'news-unknown', '这里有原文内容没能显示　');
  unknown.append(outLink(block.url || article.url, '查看原文'));
  return unknown;
}

function render(data) {
  endPress();
  article = data;
  sentences.clear();
  selection = null;
  closeWordCard();
  document.title = `${data.title} · 新闻 · JLPT 学习册`;

  const title = node('h2', 'news-article-title', data.title);
  title.lang = 'ja';
  const meta = node('p', 'news-meta');
  if (data.media) meta.append(node('span', 'news-media', data.media));
  const when = published(data.published);
  if (when) {
    const time = node('time', '', when);
    time.dateTime = data.published;
    meta.append(time);
  }
  meta.append(outLink(data.url, '原文链接'));

  const body = node('div', 'news-body');
  body.lang = 'ja';
  const blocks = data.blocks || [];
  const {at, rest} = placeErrors(blocks, data.errors || []);
  blocks.forEach((block, position) => body.append(blockNode(block, at.get(position))));
  // Missing pages (and anything not tied to a block) come after what was fetched.
  for (const info of rest) body.append(errorLine(info, open));
  $('news-article').replaceChildren(title, meta, body);
  document.dispatchEvent(new CustomEvent('news:article', {detail: {articleId: data.id}}));
}

export function open() {
  const url = new URLSearchParams(location.search).get('url');
  const root = $('news-article');
  opening?.abort();
  endPress();
  article = null;
  sentences.clear();
  selection = null;
  closeWordCard();
  if (!url) {
    root.replaceChildren(errorLine(clientInfo('缺少文章链接', false)));
    return;
  }
  const controller = opening = new AbortController();
  const progress = progressLine('正在打开文章…');
  root.replaceChildren(progress);
  streamSSE('/api/news/open', {url}, {
    signal: controller.signal,
    onEvent(name, data) {
      if (name === 'progress') progress.textContent = data.text;
      else if (name === 'article') render(data);
      else if (name === 'error') root.replaceChildren(errorLine(data, open));
    },
  }).catch(error => {
    // A bug in this page, not a network failure: say so instead of leaving the page half drawn.
    if (controller.signal.aborted) return;
    console.error(error);
    root.replaceChildren(errorLine(clientInfo(`网页显示出错：${error.message}`), open));
  });
}

// ---- Selection state ----
function highlight(sentenceId, start, end) {
  for (const element of document.querySelectorAll('.news-sentence.is-selected')) element.classList.remove('is-selected');
  for (const element of document.querySelectorAll('.news-token.is-part')) element.classList.remove('is-part');
  const found = sentences.get(sentenceId);
  if (!found) return;
  found.el.classList.add('is-selected');
  if (start == null) return;
  for (let index = start; index <= end; index++) found.el.children[index]?.classList.add('is-part');
}

function paint() {
  if (selection) highlight(selection.sentenceId, selection.start, selection.end);
  else highlight(null);
}

const fire = (name, detail) => document.dispatchEvent(new CustomEvent(name, {detail}));

document.addEventListener('news:select-sentence', event => {
  const id = event.detail?.sentenceId;
  if (!sentences.has(id)) return;
  selection = {sentenceId: id, start: null, end: null};
  paint();
});
document.addEventListener('news:select-part', event => {
  const {sentenceId, start, end} = event.detail || {};
  const found = sentences.get(sentenceId);
  if (!found || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end >= found.tokens.length) return;
  selection = {sentenceId, start, end};
  paint();
});

// ---- Gestures ----
const tokenOf = target => target instanceof Element ? target.closest('.news-token') : null;

// The token of `sentenceId` under (x, y), clamped to that sentence: a point in an earlier sentence (or
// above it) gives the first token, a later one the last; elsewhere the last token that starts at or
// before the point in reading order.
function indexAt(sentenceId, x, y) {
  const found = sentences.get(sentenceId);
  const hit = tokenOf(document.elementFromPoint(x, y));
  if (hit) {
    const id = Number(hit.dataset.s);
    if (id === sentenceId) return Number(hit.dataset.i);
    if (sentences.has(id)) return id < sentenceId ? 0 : found.tokens.length - 1;
  }
  let index = 0;
  [...found.el.children].forEach((element, position) => {
    for (const rect of element.getClientRects()) {
      if (y > rect.bottom || (y >= rect.top && x >= rect.left)) index = position;
    }
  });
  return index;
}

// Leading and trailing punctuation and spaces are dropped (numbers stay: 10日 is a unit); a range of
// punctuation only is no selection.
const EDGE_POS = new Set(['補助記号', '記号', '空白']);
function trimmed(sentenceId, start, end) {
  const {tokens} = sentences.get(sentenceId);
  const edge = token => EDGE_POS.has(token.p) || !token.s.trim();
  while (start <= end && edge(tokens[start])) start++;
  while (end >= start && edge(tokens[end])) end--;
  return start <= end ? [start, end] : null;
}

let press = null; // {pointerId, x, y, el, sentenceId, index, inSelected, mode, timer, last}

function endPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function onPointerDown(event) {
  if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
  endPress();
  const el = tokenOf(event.target);
  if (!el || !article) return;
  const sentenceId = Number(el.dataset.s);
  if (!sentences.has(sentenceId)) return;
  const state = press = {
    pointerId: event.pointerId, x: event.clientX, y: event.clientY, el, sentenceId, index: Number(el.dataset.i),
    inSelected: selection?.sentenceId === sentenceId, mode: 'pending', last: null, timer: 0,
  };
  state.timer = setTimeout(() => {
    if (press !== state || state.mode !== 'pending') return;
    state.mode = 'done';
    closeWordCard();
    fire('news:select-sentence', {sentenceId});
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
  press.last = index;
  highlight(press.sentenceId, Math.min(press.index, index), Math.max(press.index, index));
}

function onPointerUp(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  const state = press;
  endPress();
  if (state.mode === 'pending') {
    if (!state.el.classList.contains('news-word') || !state.el.isConnected) return;
    const token = sentences.get(state.sentenceId).tokens[state.index];
    showWordCard(state.el, token, state.sentenceId, state.index);
  } else if (state.mode === 'drag') {
    const index = indexAt(state.sentenceId, event.clientX, event.clientY);
    const range = trimmed(state.sentenceId, Math.min(state.index, index), Math.max(state.index, index));
    if (range) fire('news:select-part', {sentenceId: state.sentenceId, start: range[0], end: range[1]});
    else paint();
  }
}

function onPointerCancel(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  const dragging = press.mode === 'drag';
  endPress();
  if (dragging) paint();
}

const area = $('news-article');
area.addEventListener('pointerdown', onPointerDown);
document.addEventListener('pointermove', onPointerMove);
document.addEventListener('pointerup', onPointerUp);
document.addEventListener('pointercancel', onPointerCancel);
// No system menu, text selection or loupe on the article; panning is blocked only when a touch starts
// on the selected sentence (touch-action on an inline sentence is not enough for WebKit).
area.addEventListener('contextmenu', event => event.preventDefault());
area.addEventListener('selectstart', event => event.preventDefault());
let touchOnSelected = false;
area.addEventListener('touchstart', event => {
  const el = tokenOf(event.target);
  touchOnSelected = Boolean(el) && selection?.sentenceId === Number(el.dataset.s);
}, {passive: true});
area.addEventListener('touchmove', event => { if (touchOnSelected && event.cancelable) event.preventDefault(); }, {passive: false});

mountHeader($('news-header'));
open();
