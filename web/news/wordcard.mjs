import {errorLine, NewsFailure, postJSON, progressLine} from '/news/api.mjs';

// The word card shown next to a tapped word: surface, reading and 朗读 on the first line, then the
// part of speech, the model's meaning (progress while loading, an error line with 重试 on failure)
// and 「在本句中的作用」, which fires news:select-part {sentenceId, start: index, end: index} on
// document. Only one card exists; tapping elsewhere, Escape or a resize closes it.
// Rapid taps: a lookup is sent LOOKUP_DELAY ms after the tap, so a word tapped over within that time is
// never asked for, and a newer tap aborts the older request so only the last word's answer is shown.
export const LOOKUP_DELAY = 150;

const POS = {
  '名詞': '名词', '代名詞': '代词', '動詞': '动词', '形容詞': '形容词', '形状詞': '形容动词', '副詞': '副词',
  '連体詞': '连体词', '接続詞': '接续词', '感動詞': '感叹词', '助詞': '助词', '助動詞': '助动词',
  '接頭辞': '接头词', '接尾辞': '接尾词', '補助記号': '符号', '記号': '符号',
};

let current = null; // {root, tokenEl, token, controller, timer}

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

// Below the word when it fits, otherwise above it; always inside the viewport.
function place(state) {
  if (!state.tokenEl.isConnected) return closeWordCard();
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
  state.root.style.left = `${left + window.scrollX}px`;
  state.root.style.top = `${top + window.scrollY}px`;
}

function failureInfo(error) {
  if (error instanceof NewsFailure) return error.info;
  return {stage: 'client', stage_label: '网页→服务器', location: '', reason: '网页出错', retryable: true, request_id: '', time: ''};
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
    document.dispatchEvent(new CustomEvent('news:select-part', {detail: {sentenceId, start: index, end: index}}));
  });
  root.append(meaning, role);
  document.body.append(root);

  const state = current = {root, tokenEl, token, controller: new AbortController(), timer: 0};
  lookup(state, meaning);
}

// A press anywhere but the card or another word closes it (a word tap replaces it instead).
document.addEventListener('pointerdown', event => {
  if (!current) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target && (current.root.contains(target) || target.closest('.news-word'))) return;
  closeWordCard();
}, true);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeWordCard(); });
window.addEventListener('resize', () => { if (current) place(current); });
