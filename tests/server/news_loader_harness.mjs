// Runs a generated `.user.js` loader with a stubbed fetch and DOM and prints what happened as JSON.
// Usage: node news_loader_harness.mjs <loader.user.js> '<scenario json>'
// Scenario: {status, body, networkError, noEval}. The main script `body` can count its runs with
// `globalThis.__runs`; with noEval, `new Function` throws an EvalError as under a strict CSP.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const [loaderPath, scenarioText] = process.argv.slice(2);
const scenario = JSON.parse(scenarioText);
const report = {requests: [], injected: 0, failures: [], unhandled: [], runs: 0, token: null};

process.on('unhandledRejection', (error) => report.unhandled.push(String(error && error.message || error)));
process.on('uncaughtException', (error) => report.unhandled.push(String(error && error.message || error)));

let context;

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.textContent = '';
    this.listeners = {};
  }
  append(...items) {
    for (const item of items) {
      this.children.push(item);
      if (item instanceof Element && item.tag === 'script') {
        report.injected += 1;
        vm.runInContext(item.textContent, context);  // what the page would do with a <script>
      }
    }
  }
  remove() {}
  attachShadow() {
    this.shadow = new Element('#shadow');
    return this.shadow;
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  text() {
    return this.children.map((c) => (c instanceof Element ? c.textContent + c.text() : String(c))).join('');
  }
}

const documentElement = new Element('html');
const document = {
  documentElement,
  createElement: (tag) => new Element(tag),
  addEventListener() {},
};

async function fetch(url, options) {
  report.requests.push({url, authorization: options && options.headers && options.headers.Authorization});
  if (scenario.networkError) throw new TypeError('Failed to fetch');
  const status = scenario.status ?? 200;
  return {status, ok: status >= 200 && status < 300, text: async () => scenario.body ?? ''};
}

context = vm.createContext({document, fetch, console}, scenario.noEval ? {codeGeneration: {strings: false}} : {});
vm.runInContext(readFileSync(loaderPath, 'utf8'), context);
await new Promise((resolve) => setTimeout(resolve, 100));

for (const host of documentElement.children) {
  if (!(host instanceof Element) || host.tag !== 'jlpt-news-loader') continue;
  const panel = host.shadow.children.find((c) => c instanceof Element && c.className === 'p');
  const links = panel.children.filter((c) => c instanceof Element && c.tag === 'a').map((a) => a.href);
  report.failures.push({text: panel.children.filter((c) => typeof c === 'string').join(''), links});
}
report.runs = vm.runInContext('globalThis.__runs || 0', context);
report.token = vm.runInContext('globalThis.__token || null', context);
console.log(JSON.stringify(report));
