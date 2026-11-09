// Marks the words of the article on the news page itself: finds the parts the site table names,
// sends their paragraph text to POST /api/news/tokenize, and wraps every token in a
// <span class="jlpt-t">. The page is only changed after `load` (React hydration on the real site
// would throw the markup away otherwise); when the page re-renders and drops the markup, the
// paragraphs are wrapped again from the cache.
import {NewsFailure, clientInfo, postJSON, scriptInfo} from './api.mjs';

const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'FIGCAPTION', 'BLOCKQUOTE', 'DIV', 'SECTION', 'TD', 'DT', 'DD']);
const SKIPPED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'BUTTON', 'TEXTAREA']);
const MAX_PARAGRAPHS = 200; // per tokenize request (server limit)
const MAX_CHARS = 20000;

// -> {roots, missing}: the first element for each of the site's selectors, and the selectors
// that match nothing.
export function findParts(site) {
  const roots = [];
  const missing = [];
  for (const selector of site.parts) {
    const element = document.querySelector(selector);
    if (element) roots.push(element);
    else missing.push(selector);
  }
  return {roots, missing};
}

function blockOf(node, root) {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (BLOCKS.has(el.tagName)) return el;
  }
  return root;
}

// -> [{text, nodes, starts}]: the not-yet-marked text of `root`, one entry per nearest block
// ancestor, in document order. starts[k] is where nodes[k] begins in text; nodes separated by a
// <br> are joined with '\n' (a sentence boundary for the server). Tabs and newlines inside text
// nodes are read as spaces, as the page renders them, so offsets stay those of node.data.
export function blocksOf(root) {
  const groups = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE && (SKIPPED.has(node.tagName) || node.classList.contains('jlpt-t'))) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'BR') {
        const group = groups.get(blockOf(node, root));
        if (group) group.brk = true;
      }
      continue;
    }
    const block = blockOf(node, root);
    let group = groups.get(block);
    if (!group) groups.set(block, group = {text: '', nodes: [], starts: [], brk: false});
    if (group.brk && group.nodes.length) group.text += '\n';
    group.brk = false;
    group.starts.push(group.text.length);
    group.nodes.push(node);
    group.text += node.data.replace(/[\t\n\r]/g, ' ');
  }
  const blocks = [];
  for (const {text, nodes, starts} of groups.values()) {
    if (text.trim()) blocks.push({text, nodes, starts});
  }
  return blocks;
}

const isBlank = text => !/\S/.test(text);

// Node offsets for a block built without blocksOf (no <br> separators).
function cumulative(nodes) {
  let at = 0;
  return nodes.map(node => (at += node.data.length) - node.data.length);
}

// Wraps each token of `sentences` ([{id, tokens}]) in block's text nodes. Tokens are located left
// to right with indexOf from the end of the previous one; only whitespace may lie between them.
// If any token does not fit, nothing is changed and the result is false. `onSpan(span, id, i)` is
// called for every piece made (a token cut by inline elements gets one piece per text node).
export function wrapBlock(block, sentences, onSpan) {
  const {text, nodes} = block;
  const starts = block.starts || cumulative(nodes);
  const ranges = [];
  let pos = 0;
  for (const {id, tokens} of sentences) {
    for (let i = 0; i < tokens.length; i++) {
      const surface = tokens[i].s;
      if (!surface) continue;
      const at = text.indexOf(surface, pos);
      if (at < 0 || !isBlank(text.slice(pos, at))) return false;
      ranges.push({start: at, end: at + surface.length, id, i, word: !!tokens[i].t});
      pos = at + surface.length;
    }
  }
  if (!ranges.length || !isBlank(text.slice(pos))) return false;
  // Cut the ranges at text-node boundaries, then rebuild each touched node in one go.
  const pieces = nodes.map(() => []);
  let k = 0;
  for (const range of ranges) {
    while (k < nodes.length && starts[k] + nodes[k].data.length <= range.start) k++;
    for (let j = k; j < nodes.length && starts[j] < range.end; j++) {
      const from = Math.max(range.start, starts[j]) - starts[j];
      const to = Math.min(range.end, starts[j] + nodes[j].data.length) - starts[j];
      if (to > from) pieces[j].push({from, to, range});
    }
  }
  nodes.forEach((node, j) => {
    if (!pieces[j].length) return;
    const data = node.data;
    const fragment = document.createDocumentFragment();
    let at = 0;
    for (const {from, to, range} of pieces[j]) {
      if (from > at) fragment.append(data.slice(at, from));
      const span = document.createElement('span');
      span.className = range.word ? 'jlpt-t jlpt-word' : 'jlpt-t';
      span.dataset.s = String(range.id);
      span.dataset.i = String(range.i);
      span.textContent = data.slice(from, to);
      fragment.append(span);
      onSpan?.(span, range.id, range.i);
      at = to;
    }
    if (at < data.length) fragment.append(data.slice(at));
    node.replaceWith(fragment);
  });
  return true;
}

function whenLoaded(run) {
  if (document.readyState === 'complete') run();
  else addEventListener('load', run, {once: true});
}

function whenParsed(run) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, {once: true});
  else run();
}

// Batches of paragraph texts within the server's per-request limits.
function batches(texts) {
  const out = [];
  let batch = [];
  let chars = 0;
  for (const text of texts) {
    if (batch.length && (batch.length >= MAX_PARAGRAPHS || chars + text.length > MAX_CHARS)) {
      out.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(text);
    chars += text.length;
  }
  if (batch.length) out.push(batch);
  return out;
}

export class Marker {
  constructor(site, {onStatus}) {
    this.site = site;
    this.onStatus = onStatus;
    this.cache = new Map();      // paragraph text -> [{id, tokens}]
    this.pending = new Map();    // paragraph text -> Promise of its tokenize request
    this.unfit = new Map();      // paragraph text -> its 标出词 error
    this.unsent = new Set();     // paragraph texts whose request failed (until 重新分词)
    this.requestErrors = [];
    this.locateError = null;
    this.sentences = new Map();  // id -> {id, paragraph, tokens, spans}
    this.wrapped = new Set();    // paragraph texts wrapped at least once
    this.nextId = 1;
    this.inflight = 0;
    this.roots = [];
    this.marked = false;         // the first wrapping pass has run
    this.awaiting = false;       // the last pass found paragraphs still waiting for tokens
    this.rewraps = 0;
    this.listeners = [];
    this.frame = 0;
    this.observer = new MutationObserver(records => {
      if (records.some(record => this.affects(record.target))) this.schedule();
    });
  }

  start() {
    this.report();
    whenParsed(() => {
      // Ask for tokens right away; the page itself is not touched before `load`.
      const {roots} = findParts(this.site);
      this.request(roots.flatMap(root => blocksOf(root).map(block => block.text)));
      whenLoaded(() => requestAnimationFrame(() => this.locate()));
    });
  }

  locate() {
    const {missing} = findParts(this.site);
    if (missing.length) {
      this.locateError = scriptInfo('locate', `页面上找不到 ${missing.join('、')}`, '', false);
      return this.report();
    }
    this.locateError = null;
    this.observer.observe(document.documentElement, {childList: true, subtree: true, characterData: true});
    this.scan();
  }

  // 重新分词: forget every token, take the marks off and start over.
  retokenize() {
    this.cache.clear();
    this.unfit.clear();
    this.unsent.clear();
    this.wrapped.clear();
    this.sentences.clear();
    this.requestErrors = [];
    if (this.locateError) return this.locate();
    if (!this.marked) return this.report(); // still waiting for `load`; that pass asks again
    for (const root of this.roots) {
      const blocks = new Set();
      for (const span of root.querySelectorAll('.jlpt-t')) {
        blocks.add(span.parentNode);
        span.replaceWith(...span.childNodes);
      }
      for (const block of blocks) block.normalize();
    }
    this.observer.takeRecords();
    this.scan();
  }

  sentence(id) {
    return this.sentences.get(id);
  }

  // callback(ids) after a pass that wrapped paragraphs again (their old spans are gone).
  onRewrap(callback) {
    this.listeners.push(callback);
  }

  affects(target) {
    if (target.nodeType !== Node.ELEMENT_NODE) target = target.parentNode;
    if (!target) return false;
    return this.roots.some(root => !root.isConnected || root.contains(target) || target.contains(root));
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.scan();
    });
  }

  // One pass: wrap every unmarked paragraph that has tokens; ask for the ones that do not.
  scan() {
    const {roots} = findParts(this.site);
    this.roots = roots;
    const blocks = roots.flatMap(root => blocksOf(root));
    const ask = [];
    const rewrapped = [];
    blocks.forEach((block, n) => {
      const text = block.text;
      if (this.unfit.has(text) || this.unsent.has(text)) return;
      const sentences = this.cache.get(text);
      if (!sentences) return ask.push(text);
      const records = sentences.map(({id, tokens}) => ({id, paragraph: text, tokens, spans: tokens.map(() => [])}));
      const byId = new Map(records.map(record => [record.id, record]));
      if (!wrapBlock(block, sentences, (span, id, i) => byId.get(id).spans[i].push(span))) {
        this.unfit.set(text, scriptInfo('mark', '分词结果和原文对不上', `第 ${n + 1} 段`));
        return;
      }
      for (const record of records) this.sentences.set(record.id, record);
      if (this.wrapped.has(text)) rewrapped.push(...records.map(record => record.id));
      this.wrapped.add(text);
    });
    this.observer.takeRecords(); // our own wrapping is not a page change
    this.marked = true;
    const html = document.documentElement.dataset;
    html.jlptWords = String(roots.reduce((sum, root) => sum + root.querySelectorAll('.jlpt-word').length, 0));
    if (rewrapped.length) this.rewraps++;
    html.jlptRewraps = String(this.rewraps);
    if (rewrapped.length) for (const callback of this.listeners) callback(rewrapped);
    this.awaiting = ask.length > 0;
    if (ask.length) this.request(ask).then(() => this.schedule());
    this.report();
  }

  // Tokenizes the texts not cached or already asked for; resolves when all of them are settled.
  request(texts) {
    const fresh = [...new Set(texts)].filter(text => !this.cache.has(text) && !this.pending.has(text) && !this.unsent.has(text));
    for (const batch of batches(fresh)) {
      this.inflight++;
      const sent = postJSON('/api/news/tokenize', {paragraphs: batch}).then(reply => {
        const list = reply && Array.isArray(reply.paragraphs) ? reply.paragraphs : null;
        const fits = paragraph => Array.isArray(paragraph) && paragraph.every(sentence => Array.isArray(sentence?.tokens));
        if (!list || list.length !== batch.length || !list.every(fits)) {
          throw new NewsFailure(clientInfo('服务器回应格式不对', '/api/news/tokenize'));
        }
        batch.forEach((text, n) => {
          this.cache.set(text, list[n].map(sentence => ({id: this.nextId++, tokens: sentence.tokens})));
        });
      }).catch(error => {
        for (const text of batch) this.unsent.add(text);
        const info = error instanceof NewsFailure ? error.info : clientInfo(`分词结果处理失败：${error.message}`, '/api/news/tokenize');
        this.requestErrors.push(info);
      }).finally(() => {
        for (const text of batch) this.pending.delete(text);
        this.inflight--;
        this.report();
      });
      for (const text of batch) this.pending.set(text, sent);
    }
    return Promise.all([...new Set(texts)].map(text => this.pending.get(text)));
  }

  report() {
    const errors = [this.locateError, ...this.requestErrors, ...this.unfit.values()].filter(Boolean);
    const state = errors.length ? 'error' : this.inflight || this.awaiting || !this.marked ? 'tokenizing' : 'ready';
    this.onStatus({state, errors});
  }
}
