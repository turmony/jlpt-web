import test from 'node:test';
import assert from 'node:assert/strict';
import {configureDebug, debug} from '../../news-client/debug.mjs';

// A stand-in for the page's document: records the events dispatched on it.
function fakeDocument() {
  const seen = [];
  globalThis.document = {dispatchEvent: event => { seen.push([event.type, event.detail]); return true; }};
  return seen;
}
test.afterEach(() => { delete globalThis.document; configureDebug(undefined); });

test('with the loader function the line goes straight to it', () => {
  const seen = fakeDocument();
  const calls = [];
  configureDebug((message, level) => calls.push([message, level]));
  debug('站点已匹配: 雅虎新闻', 'ok');
  debug('状态: 分词中');
  assert.deepEqual(calls, [['站点已匹配: 雅虎新闻', 'ok'], ['状态: 分词中', undefined]]);
  assert.deepEqual(seen, []);
});

test('debug: true (an injected <script>, the function lost in the JSON) sends a jlpt-news-debug event', () => {
  const seen = fakeDocument();
  configureDebug(true);
  debug('主脚本已运行', 'warn');
  assert.deepEqual(seen, [['jlpt-news-debug', JSON.stringify({message: '主脚本已运行', level: 'warn'})]]);
});

test('debug switched off, or a loader from before the overlay (no debug at all), sends nothing', () => {
  for (const value of [false, undefined, 'true', 1]) {
    const seen = fakeDocument();
    configureDebug(value);
    debug('x');
    assert.deepEqual(seen, [], String(value));
  }
});

test('a failing sink never reaches the caller', () => {
  configureDebug(() => { throw new Error('overlay gone'); });
  assert.doesNotThrow(() => debug('x'));
  globalThis.document = {dispatchEvent() { throw new Error('no document'); }};
  configureDebug(true);
  assert.doesNotThrow(() => debug('x'));
});
