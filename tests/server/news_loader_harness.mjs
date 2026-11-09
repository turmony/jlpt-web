// Runs a generated `.user.js` loader with a stubbed fetch and DOM and prints what happened as JSON.
// Usage: node news_loader_harness.mjs <loader.user.js> '<scenario json>'
// Scenario: {status, body, networkError, noEval, noScript, url, lateRoot}. The main script `body` can
// count its runs with `globalThis.__runs`; with noEval, `new Function` throws an EvalError as under a
// strict CSP; with noScript an injected <script> does not run (a CSP without inline scripts). `url` is
// the page address (default an article page); with lateRoot, document.documentElement is missing at
// first and comes with a readystatechange.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const [loaderPath, scenarioText] = process.argv.slice(2);
const scenario = JSON.parse(scenarioText);
const report = {requests: [], injected: 0, failures: [], unhandled: [], pageErrors: [], runs: 0, token: null, debug: null};

process.on('unhandledRejection', (error) => report.unhandled.push(String(error && error.message || error)));
process.on('uncaughtException', (error) => report.unhandled.push(String(error && error.message || error)));

let context;

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.textContent = '';
    this.className = '';
    this.listeners = {};
    this.parent = null;
  }
  append(...items) {
    for (const item of items) {
      if (item instanceof Element) item.parent = this;
      this.children.push(item);
      if (item instanceof Element && item.tag === 'script') {
        report.injected += 1;
        if (scenario.noScript) continue;
        // What the page would do with a <script>: its errors go to the page, not to the caller.
        try {
          vm.runInContext(item.textContent, context);
        } catch (error) {
          report.pageErrors.push(String(error && error.message || error));
        }
      }
    }
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  attachShadow(init) {
    this.shadowMode = init && init.mode;
    this.shadow = new Element('#shadow');
    return this.shadow;
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  setAttribute(name, value) {
    this[name] = String(value);
  }
  text() {
    return this.children.map((c) => (c instanceof Element ? c.textContent + c.text() : String(c))).join('');
  }
  find(className) {
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      if (child.className.split(' ').includes(className)) return child;
      const found = child.find(className);
      if (found) return found;
    }
    return null;
  }
}

class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
}

const documentElement = new Element('html');
const listeners = {};
const document = {
  get documentElement() { return scenario.lateRoot && !rooted ? null : documentElement; },
  readyState: 'loading',
  createElement: (tag) => new Element(tag),
  addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); return true; },
};
let rooted = false;

async function fetch(url, options) {
  report.requests.push({url, authorization: options && options.headers && options.headers.Authorization});
  if (scenario.networkError) throw new TypeError('Failed to fetch');
  const status = scenario.status ?? 200;
  return {status, ok: status >= 200 && status < 300, text: async () => scenario.body ?? ''};
}

const page = new URL(scenario.url || 'https://news.yahoo.co.jp/articles/abc123');
const location = {origin: page.origin, pathname: page.pathname, search: page.search, href: page.href};
context = vm.createContext({document, fetch, console, location, CustomEvent, TextEncoder},
  scenario.noEval ? {codeGeneration: {strings: false}} : {});
vm.runInContext(readFileSync(loaderPath, 'utf8'), context);
if (scenario.lateRoot) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  rooted = true;
  document.readyState = 'interactive';
  document.dispatchEvent(new CustomEvent('readystatechange'));
}
await new Promise((resolve) => setTimeout(resolve, 100));

for (const host of documentElement.children) {
  if (!(host instanceof Element)) continue;
  if (host.tag === 'jlpt-news-debug') {
    const list = host.shadow.find('l');
    report.debug = {
      mode: host.shadowMode,
      count: documentElement.children.filter((c) => c instanceof Element && c.tag === 'jlpt-news-debug').length,
      lines: list.children.map((line) => ({text: line.textContent, level: line.className})),
    };
  }
  if (host.tag !== 'jlpt-news-loader') continue;
  const panel = host.shadow.children.find((c) => c instanceof Element && c.className === 'p');
  const links = panel.children.filter((c) => c instanceof Element && c.tag === 'a').map((a) => a.href);
  report.failures.push({text: panel.children.filter((c) => typeof c === 'string').join(''), links});
}
report.runs = vm.runInContext('globalThis.__runs || 0', context);
report.token = vm.runInContext('globalThis.__token || null', context);
report.debugType = vm.runInContext('globalThis.__debugType || null', context);
console.log(JSON.stringify(report));
