// The analysis panel on the news page: what a sentence (or a part of it) means, then a conversation
// about it. It lives in the <jlpt-news> shadow root's layer and listens to reader.mjs's events on
// document:
//   jlpt:select-sentence {sentenceId}            analyse the whole sentence
//   jlpt:select-part {sentenceId, start, end}    analyse that part (the word card may name another sentence)
//
// State: {sentenceId, start, end, analysisText, analysis, history: [{q, a}]}. start/end are null for the
// whole sentence; analysisText is the last done.analysis_text of the current selection, sent back with
// every question; analysis is 'running' | 'done' | 'failed'.
//   another sentence            -> history cleared, new analysis
//   another part, same sentence -> new analysis, history kept
//   close (button, drag down)   -> everything cleared, streams aborted, the reader's selection removed
// Every new analysis aborts the analysis and the answer in progress; a new question aborts the previous
// answer. The sentence and the analysis always go with a question: one asked while the analysis is still
// running waits on screen and is sent when the analysis ends (with its analysis_text, or with none if
// it failed). Each stream also carries its own number and draws nothing once it is not the current one.
// The sentence goes to the server as its paragraph text and its words (Marker.sentence).
//
// Layout (ui.css): a column floating over the right 35% of wide landscape screens, otherwise a bottom
// sheet whose handle drags it up to full screen or down to close. The layer gets panel-open / panel-wide
// / panel-full / panel-dragging so the dock can keep out of the way.
import {clientInfo, errorLine, progressLine, siteUrl, streamSSE} from './api.mjs';
import {clearSelection} from './reader.mjs';

export const MAX_ROUNDS = 6;
// The server's limits (server/news.py): longer texts are cut here, so one long answer cannot get every
// later question rejected, and a very long paragraph is sent as the stretch around the sentence.
const MAX_HISTORY_TEXT = 4000;
const MAX_ANALYSIS = 20000;
const MAX_PARAGRAPH = 4000;
const WIDE = matchMedia('(min-width: 900px) and (orientation: landscape)');
const CARD_LINK = /^\/grammar\/#N[1-5]\/\d+-\d+$/;
const OPEN_PX = 60;  // upward drag on the handle that opens the sheet to full screen
const CLOSE_PX = 80; // downward drag that closes it (or, from full screen, returns it to half height)

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function section(name, label) {
  const element = node('section', `news-panel-section ${name}`);
  if (label) element.append(node('h3', '', label));
  return element;
}

const cut = (text, limit) => text.length > limit ? text.slice(0, limit) : text;

// The paragraph, or for one over the server's limit the stretch of it around the sentence.
function paragraphFor(paragraph, sentence) {
  if (paragraph.length <= MAX_PARAGRAPH) return paragraph;
  const at = Math.max(0, paragraph.indexOf(sentence));
  const room = Math.max(0, MAX_PARAGRAPH - sentence.length);
  const start = Math.max(0, Math.min(at - Math.floor(room / 2), paragraph.length - MAX_PARAGRAPH));
  return paragraph.slice(start, start + MAX_PARAGRAPH);
}

// A failure of the script's own code (streamSSE rejects when a handler throws).
function scriptBug(error, path) {
  console.error(error);
  return clientInfo(`脚本出错：${error?.message || error}`, path);
}

export function mountPanel(layer, marker) {
  // ---- Skeleton ----
  const root = node('div', 'news-panel');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '句子分析');
  root.lang = 'zh-CN';
  const head = node('div', 'news-panel-head');
  const handle = node('div', 'news-panel-handle');
  handle.setAttribute('aria-hidden', 'true');
  const closeButton = node('button', 'news-panel-close', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '关闭');
  head.append(handle, closeButton);
  const body = node('div', 'news-panel-body');
  const chat = section('news-panel-chat', '追问');
  const chatList = node('div', 'news-chat');
  chat.append(chatList);
  chat.hidden = true;
  const form = node('form', 'news-ask');
  const input = node('input', 'news-ask-input');
  input.type = 'text';
  input.placeholder = '想问什么…';
  input.maxLength = 500;
  input.enterKeyHint = 'send';
  input.setAttribute('aria-label', '追问');
  const send = node('button', 'news-ask-send', '发送');
  send.type = 'submit';
  form.append(input, send);
  root.append(head, body, form);
  layer.append(root);

  let state = null;
  let analysisRun = 0;   // number of the current analysis stream
  let analyzing = null;  // its AbortController
  let askRun = 0;        // number of the current answer stream
  let asking = null;     // its AbortController
  let pending = null;    // the round element of a question not yet answered (or failed)
  let queued = null;     // a question waiting for the running analysis to end

  const layout = () => {
    const open = !root.hidden;
    layer.classList.toggle('panel-open', open);
    layer.classList.toggle('panel-wide', open && WIDE.matches);
    layer.classList.toggle('panel-full', open && root.classList.contains('is-full'));
    // While the sheet is open the page gets room below its end (main.mjs PAGE_CSS), so the last
    // sentences can still be scrolled above the sheet.
    if (open && !WIDE.matches) document.documentElement.dataset.jlptPanel = 'sheet';
    else delete document.documentElement.dataset.jlptPanel;
  };

  // What every request about the current selection carries.
  function selectionBody() {
    const {sentenceId, start, end} = state;
    const sentence = marker.sentence(sentenceId);
    const tokens = sentence.tokens.map(token => token.s);
    return {paragraph: paragraphFor(sentence.paragraph, tokens.join('')), tokens, start, end};
  }

  // ---- Analysis ----
  function originalBlock(sentence, start, end) {
    const block = section('news-panel-original', '原文');
    const text = node('p', 'news-panel-sentence');
    text.lang = 'ja';
    const words = sentence.tokens.map(token => token.s);
    if (start == null) text.textContent = words.join('');
    else text.append(words.slice(0, start).join(''), node('mark', 'news-panel-part', words.slice(start, end + 1).join('')), words.slice(end + 1).join(''));
    block.append(text);
    return block;
  }

  function grammarItem(data) {
    const item = node('li', 'news-grammar-item');
    item.dataset.related = String(Boolean(data.related));
    const line = node('div', 'news-grammar-line');
    const row = node('button', 'news-grammar-row');
    row.type = 'button';
    row.setAttribute('aria-expanded', 'false');
    const formText = node('span', 'news-grammar-form', data.form || '');
    formText.lang = 'ja';
    row.append(formText, node('span', 'news-grammar-level', data.level || ''), node('span', 'news-grammar-brief', data.brief || ''));
    line.append(row);
    if (typeof data.card === 'string' && CARD_LINK.test(data.card)) {
      const link = node('a', 'news-grammar-card', '语法卡');
      link.href = siteUrl(data.card);
      link.target = '_blank';
      link.rel = 'noopener';
      line.append(link);
    }
    const detail = node('div', 'news-grammar-detail');
    detail.hidden = true;
    if (data.connection) detail.append(node('p', '', `接续：${data.connection}`));
    if (data.usage) detail.append(node('p', '', `本句用法：${data.usage}`));
    if (data.confusable) detail.append(node('p', '', `易混淆：${data.confusable}`));
    row.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      row.setAttribute('aria-expanded', String(!detail.hidden));
    });
    item.append(line, detail);
    return item;
  }

  function setAnalysis(value) {
    if (state) state.analysis = value;
    if (value) root.dataset.analysis = value;
    else delete root.dataset.analysis;
  }

  function analyze() {
    analyzing?.abort();
    stopAsking();
    const run = ++analysisRun;
    const controller = analyzing = new AbortController();
    const current = () => run === analysisRun && !controller.signal.aborted;
    const {sentenceId, start, end} = state;
    state.analysisText = '';
    setAnalysis('running');

    const sentence = marker.sentence(sentenceId);
    const selection = start == null ? null : section('news-panel-selection');
    if (selection) selection.hidden = true;
    const translation = section('news-panel-translation', '译文');
    translation.hidden = true;
    const grammar = section('news-panel-grammar', '语法');
    grammar.hidden = true;
    const list = node('ul', 'news-grammar');
    grammar.append(list);
    const extra = section('news-panel-extra', '其他内容');
    extra.hidden = true;
    const status = node('div', 'news-panel-status');
    const progress = progressLine('正在发送…');
    status.append(progress);
    body.replaceChildren(...[originalBlock(sentence, start, end), selection, translation, grammar, extra, status, chat].filter(Boolean));

    const handlers = {
      progress(data) { progress.textContent = data.text; },
      selection(data) {
        if (!selection) return; // the template has no selection for a whole sentence
        const top = node('p', 'news-selection-head');
        const text = node('span', 'news-selection-text', sentence.tokens.slice(start, end + 1).map(token => token.s).join(''));
        const reading = node('span', 'news-selection-reading', data.reading || '');
        text.lang = reading.lang = 'ja';
        top.append(text, reading);
        selection.replaceChildren(top, node('p', 'news-selection-role', data.role || ''), node('p', 'news-selection-meaning', `本句中：${data.meaning || ''}`));
        selection.hidden = false;
      },
      translation(data) {
        translation.querySelector('.news-translation')?.remove();
        translation.append(node('p', 'news-translation', data.text || ''));
        translation.hidden = false;
      },
      grammar(data) {
        const item = grammarItem(data);
        // Related items lead, in their own arrival order.
        const firstOther = data.related ? list.querySelector('.news-grammar-item[data-related="false"]') : null;
        list.insertBefore(item, firstOther);
        grammar.hidden = false;
      },
      extra(data) {
        extra.querySelector('.news-extra-text')?.remove();
        extra.append(node('p', 'news-extra-text', data.text || ''));
        extra.hidden = false;
      },
      done(data) {
        state.analysisText = typeof data.analysis_text === 'string' ? data.analysis_text : '';
        status.replaceChildren();
        setAnalysis('done');
        analyzing = null;
        sendQueued();
      },
      error(data) {
        status.replaceChildren(errorLine(data, retryAnalysis));
        setAnalysis('failed');
        analyzing = null;
        sendQueued();
      },
    };
    streamSSE('/api/news/analyze', selectionBody(), {
      signal: controller.signal,
      onEvent(name, data) {
        if (current()) handlers[name]?.(data);
      },
    }).catch(error => {
      if (current()) handlers.error(scriptBug(error, '/api/news/analyze'));
    });
  }

  function retryAnalysis() {
    if (state && marker.sentence(state.sentenceId)) analyze();
  }

  // ---- Questions ----
  function roundNode(question) {
    const round = node('div', 'news-chat-round');
    round.append(node('p', 'news-chat-q', `我：${question}`));
    const answer = node('p', 'news-chat-a', '答：');
    const text = node('span', 'news-chat-text');
    answer.append(text);
    round.append(answer);
    return {round, answer, text};
  }

  function renderChat() {
    chatList.replaceChildren(...state.history.map(({q, a}) => {
      const {round, text} = roundNode(q);
      text.textContent = a;
      return round;
    }));
    chat.hidden = !state.history.length;
  }

  function stopAsking() {
    asking?.abort();
    asking = null;
    queued = null;
    askRun++;
    pending?.remove();
    pending = null;
    send.disabled = false;
    if (state) chat.hidden = !state.history.length;
  }

  // Shows the question at once; it is sent when the running analysis ends (sendQueued).
  function queue(question) {
    stopAsking();
    const {round, answer} = roundNode(question);
    round.classList.add('is-pending');
    answer.hidden = true;
    const slot = node('div', 'news-chat-slot');
    slot.append(progressLine('分析完成后发送…'));
    round.append(slot);
    pending = round;
    queued = question;
    chatList.append(round);
    chat.hidden = false;
    send.disabled = true;
    round.scrollIntoView({block: 'nearest'});
  }

  function sendQueued() {
    if (queued !== null && state) ask(queued);
  }

  function ask(question) {
    stopAsking(); // also drops a failed round still on screen: what is shown is what the model is sent
    if (!marker.sentence(state.sentenceId)) return;
    const run = askRun;
    const controller = asking = new AbortController();
    const live = () => run === askRun && !controller.signal.aborted;
    const analysis = cut(state.analysisText, MAX_ANALYSIS);
    const history = state.history.slice(-MAX_ROUNDS).map(({q, a}) => ({q: cut(q, MAX_HISTORY_TEXT), a: cut(a, MAX_HISTORY_TEXT)}));
    const {round, answer, text} = roundNode(question);
    round.classList.add('is-pending');
    const slot = node('div', 'news-chat-slot');
    const progress = progressLine('正在发送…');
    slot.append(progress);
    round.append(slot);
    pending = round;
    chatList.append(round);
    chat.hidden = false;
    send.disabled = true;
    round.scrollIntoView({block: 'nearest'});
    let reply = '';
    const finish = () => {
      asking = null;
      send.disabled = false;
    };
    const handlers = {
      progress(data) { progress.textContent = data.text; },
      delta(data) {
        reply += data.text || '';
        text.textContent = reply;
        progress.remove();
      },
      done() {
        state.history.push({q: question, a: reply});
        round.classList.remove('is-pending');
        slot.remove();
        pending = null;
        finish();
      },
      error(data) {
        if (!reply) answer.hidden = true;
        slot.replaceChildren(errorLine(data, () => { if (state && pending === round) ask(question); }));
        finish();
      },
    };
    streamSSE('/api/news/ask', {...selectionBody(), analysis, history, question}, {
      signal: controller.signal,
      onEvent(name, data) {
        if (live()) handlers[name]?.(data);
      },
    }).catch(error => {
      if (live()) handlers.error(scriptBug(error, '/api/news/ask'));
    });
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const question = input.value.trim();
    if (!state || !question || asking || queued !== null) return;
    input.value = '';
    if (state.analysis === 'running') queue(question);
    else ask(question);
  });

  // ---- Opening and closing ----
  function select(sentenceId, start, end) {
    const sentence = marker.sentence(sentenceId);
    if (!sentence) return;
    if (start != null && !(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end < sentence.tokens.length)) return;
    const same = state && state.sentenceId === sentenceId;
    if (same && state.start === start && state.end === end && state.analysis !== 'failed') return show();
    if (same) {
      state.start = start;
      state.end = end;
    } else {
      stopAsking();
      state = {sentenceId, start, end, analysisText: '', analysis: null, history: []};
      renderChat();
    }
    show();
    analyze();
  }

  function show() {
    const opening = root.hidden;
    root.hidden = false;
    layout();
    if (opening && !WIDE.matches) reveal();
  }

  // Scrolls just enough to keep the selected sentence above a freshly opened bottom sheet (its start
  // wins when the sentence is taller than the space left).
  function reveal() {
    const pieces = marker.sentence(state.sentenceId)?.spans.flat().filter(span => span.isConnected) || [];
    const rects = pieces.flatMap(span => [...span.getClientRects()]);
    if (!rects.length) return;
    const top = Math.min(...rects.map(rect => rect.top));
    const bottom = Math.max(...rects.map(rect => rect.bottom));
    const sheetTop = root.getBoundingClientRect().top;
    let delta = 0;
    if (bottom > sheetTop - 16) delta = bottom - (sheetTop - 16);
    if (top - delta < 8) delta = top - 8;
    if (delta) window.scrollBy(0, delta);
  }

  function closePanel() {
    analysisRun++;
    analyzing?.abort();
    analyzing = null;
    stopAsking();
    state = null;
    setAnalysis(null);
    body.replaceChildren();
    chatList.replaceChildren();
    chat.hidden = true;
    input.value = '';
    root.hidden = true;
    root.classList.remove('is-full', 'is-dragging');
    root.style.removeProperty('--sheet-height');
    layer.classList.remove('panel-dragging');
    layout();
    clearSelection();
  }

  closeButton.addEventListener('click', closePanel);
  document.addEventListener('jlpt:select-sentence', event => select(event.detail?.sentenceId, null, null));
  document.addEventListener('jlpt:select-part', event => {
    const {sentenceId, start, end} = event.detail || {};
    if (Number.isInteger(start)) select(sentenceId, start, end);
  });

  // ---- Bottom sheet: drag the handle up to full screen, down to half height or closed ----
  let sheetDrag = null; // {pointerId, y, height, full}
  const dragging = on => {
    root.classList.toggle('is-dragging', on);
    layer.classList.toggle('panel-dragging', on);
  };

  handle.addEventListener('pointerdown', event => {
    if (WIDE.matches || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    sheetDrag = {pointerId: event.pointerId, y: event.clientY, height: root.getBoundingClientRect().height, full: root.classList.contains('is-full')};
    dragging(true);
  });
  document.addEventListener('pointermove', event => {
    if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
    event.preventDefault();
    const height = Math.max(0, Math.min(innerHeight, sheetDrag.height - (event.clientY - sheetDrag.y)));
    root.style.setProperty('--sheet-height', `${height}px`);
  });
  function endSheetDrag(event, cancelled) {
    if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
    const {y, height, full} = sheetDrag;
    sheetDrag = null;
    dragging(false);
    root.style.removeProperty('--sheet-height');
    if (cancelled) return;
    const moved = event.clientY - y;
    if (!full && moved <= -OPEN_PX) root.classList.add('is-full');
    else if (moved >= CLOSE_PX && (!full || height - moved < innerHeight * 0.35)) return closePanel();
    else if (full && moved >= CLOSE_PX) root.classList.remove('is-full');
    layout();
  }
  document.addEventListener('pointerup', event => endSheetDrag(event, false));
  document.addEventListener('pointercancel', event => endSheetDrag(event, true));
  WIDE.addEventListener?.('change', () => {
    root.classList.remove('is-full');
    layout();
  });

  return {close: closePanel};
}
