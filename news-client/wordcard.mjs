// The word card shown next to a tapped word: surface, reading and 朗读 on the first line, then the
// part of speech, the model's meaning (progress while loading, an error line on failure, with 重试
// when it can be retried) and 「在本句中的作用」, which fires jlpt:select-part
// {sentenceId, start: index, end: index} on document. Only one card exists, in the <jlpt-news>
// shadow root's layer, fixed at the word's viewport position; tapping elsewhere, Escape or
// scrolling the page closes it.
// Rapid taps: a lookup is sent LOOKUP_DELAY ms after the tap, so a word tapped over within that time
// is never asked for, and a newer tap aborts the older request so only the last word's answer is shown.
import {clientInfo, errorLine, NewsFailure, postJSON, progressLine} from './api.mjs';

export const LOOKUP_DELAY = 150;

const POS = {
  '名詞': '名词', '代名詞': '代词', '動詞': '动词', '形容詞': '形容词', '形状詞': '形容动词', '副詞': '副词',
  '連体詞': '连体词', '接続詞': '接续词', '感動詞': '感叹词', '助詞': '助词', '助動詞': '助动词',
  '接頭辞': '接头词', '接尾辞': '接尾词', '補助記号': '符号', '記号': '符号',
};

let layer = null;
let current = null; // {root, tokenEl, token, sentenceId, index, controller, timer, scroll}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function canSpeak() {
  return typeof window.speechSynthesis === 'object' && window.speechSynthesis !== null && typeof window.SpeechSynthesisUtterance === 'function';
}

function say(text) {
  try {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP';
    const voice = speechSynthesis.getVoices().find(item => /^ja/i.test(item.lang));
    if (voice) utterance.voice = voice;
    speechSynthesis.speak(utterance);
  } catch {}
}

export function closeWordCard() {
  if (!current) return;
  clearTimeout(current.timer);
  current.controller.abort();
  current.root.remove();
  current = null;
}

// After a re-render the tapped piece is gone but the word comes back with the same sentence id
// and index: the card follows its new piece. Only a word that is no longer on the page closes it.
function anchor(state) {
  if (state.tokenEl.isConnected) return true;
  const piece = document.querySelector(`.jlpt-t[data-s="${state.sentenceId}"][data-i="${state.index}"]`);
  if (piece) state.tokenEl = piece;
  return !!piece;
}

// Below the word when it fits, otherwise above it; always inside the viewport.
function place(state) {
  if (!anchor(state)) return closeWordCard();
  const rect = state.tokenEl.getClientRects()[0] || state.tokenEl.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = window.innerHeight;
  const margin = 8;
  const gap = 6;
  const cardWidth = state.root.offsetWidth;
  const cardHeight = state.root.offsetHeight;
  let top = rect.bottom + gap;
  if (top + cardHeight > height - margin && rect.top - gap - cardHeight >= margin) top = rect.top - gap - cardHeight;
  top = Math.max(margin, Math.min(top, height - margin - cardHeight));
  const left = Math.max(margin, Math.min(rect.left, width - margin - cardWidth));
  state.root.style.left = `${left}px`;
  state.root.style.top = `${top}px`;
}

function failureInfo(error) {
  if (error instanceof NewsFailure) return error.info;
  return clientInfo(`脚本出错：${error?.message || error}`, '/api/news/gloss');
}

function lookup(state, meaning) {
  clearTimeout(state.timer);
  state.controller.abort();
  const controller = state.controller = new AbortController();
  meaning.replaceChildren(progressLine('正在查询释义…'));
  place(state);
  const {token} = state;
  const body = {lemma: (token.l || token.s).slice(0, 50), reading: (token.r || '').slice(0, 100), pos: (token.p || '').slice(0, 50)};
  state.timer = setTimeout(async () => {
    let shown;
    try {
      const data = await postJSON('/api/news/gloss', body, {signal: controller.signal});
      shown = () => { meaning.textContent = data.meaning; };
    } catch (error) {
      shown = () => meaning.replaceChildren(errorLine(failureInfo(error), () => lookup(state, meaning)));
    }
    if (controller.signal.aborted || current !== state) return;
    shown();
    place(state);
  }, LOOKUP_DELAY);
}

export function showWordCard(tokenEl, token, sentenceId, index) {
  closeWordCard();
  const root = node('div', 'news-card');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', `查词：${token.s}`);
  root.lang = 'zh-CN';

  const head = node('div', 'news-card-head');
  const word = node('span', 'news-card-word', token.s);
  word.lang = 'ja';
  head.append(word);
  if (token.r && token.r !== token.s) {
    const reading = node('span', 'news-card-reading', token.r);
    reading.lang = 'ja';
    head.append(reading);
  }
  if (canSpeak()) {
    const speak = node('button', 'news-card-speak', '🔊');
    speak.type = 'button';
    speak.setAttribute('aria-label', '朗读');
    speak.addEventListener('click', () => say(token.s));
    head.append(speak);
  }
  root.append(head, node('div', 'news-card-pos', POS[token.p] || token.p || '未知词性'));
  if (token.l && token.l !== token.s) {
    const lemma = node('div', 'news-card-lemma', '原形：');
    const form = node('span', '', token.l);
    form.lang = 'ja';
    lemma.append(form);
    root.append(lemma);
  }
  const meaning = node('div', 'news-card-meaning');
  meaning.setAttribute('aria-live', 'polite');
  const role = node('button', 'news-card-role', '在本句中的作用');
  role.type = 'button';
  role.addEventListener('click', () => {
    closeWordCard();
    document.dispatchEvent(new CustomEvent('jlpt:select-part', {detail: {sentenceId, start: index, end: index}}));
  });
  root.append(meaning, role);
  layer.append(root);

  const state = current = {root, tokenEl, token, sentenceId, index, controller: new AbortController(), timer: 0, scroll: [scrollX, scrollY]};
  lookup(state, meaning);
}

// Called after the page was re-wrapped: moves an open card to its word's new piece.
export function anchorWordCard() {
  if (current) place(current);
}

// `into`: the shadow root's layer (ui.mjs) the card is put in.
export function mountWordCard(into) {
  layer = into;
  // A press anywhere but the card or another word closes it (a word tap replaces it instead).
  document.addEventListener('pointerdown', event => {
    if (!current || event.composedPath().includes(current.root)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.jlpt-word')) return;
    closeWordCard();
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeWordCard(); });
  window.addEventListener('resize', () => { if (current) place(current); });
  // Only a real move counts: a scroll event that arrives late for a scroll made before the card
  // opened leaves it alone.
  window.addEventListener('scroll', () => {
    if (current && (scrollX !== current.scroll[0] || scrollY !== current.scroll[1])) closeWordCard();
  }, {passive: true});
}
