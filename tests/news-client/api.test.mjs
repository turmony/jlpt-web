import test from 'node:test';
import assert from 'node:assert/strict';
import {configure, siteUrl, getJSON, postJSON, streamSSE, sseParser, NewsFailure, clientInfo, scriptInfo} from '../../news-client/api.mjs';

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const json = (status, body) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

test('requests go to base with the bearer token', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init]); return json(200, {ok: true}); };
  configure({base: 'https://a', token: 'T', install: 'https://a/news-script/'});
  assert.deepEqual(await getJSON('/api/news/models'), {ok: true});
  assert.equal(calls[0][0], 'https://a/api/news/models');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer T');
  await postJSON('/api/news/settings', {model: 'm'});
  assert.equal(calls[1][0], 'https://a/api/news/settings');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer T');
  assert.equal(calls[1][1].headers['Content-Type'], 'application/json');
});

test('a 401 becomes the reinstall failure with the install link', async () => {
  configure({base: 'https://a', token: 'T'});
  globalThis.fetch = async () => json(401, {error: {stage: 'client', stage_label: '脚本→服务器', location: '/api/news/models', reason: '令牌已失效，请重新安装脚本', retryable: false, request_id: 'r1', time: '10:00:00', install: 'https://a/news-script/'}});
  await assert.rejects(getJSON('/api/news/models'), error => {
    assert.ok(error instanceof NewsFailure);
    assert.equal(error.info.reason, '令牌已失效，请重新安装脚本');
    assert.equal(error.info.retryable, false);
    assert.equal(error.info.install, 'https://a/news-script/');
    return true;
  });
  // The server gave no error dict: the script builds the same failure itself.
  globalThis.fetch = async () => json(401, {error: '请登录'});
  await assert.rejects(getJSON('/api/news/models'), error => {
    assert.equal(error.info.reason, '令牌已失效，请重新安装脚本');
    assert.equal(error.info.retryable, false);
    assert.equal(error.info.stage_label, '脚本→服务器');
    assert.equal(error.info.location, '/api/news/models');
    assert.equal(error.info.install, 'https://a/news-script/');
    return true;
  });
});

test('script-made failures carry their stage label', () => {
  assert.equal(clientInfo('x', '/p?q=1').stage_label, '脚本→服务器');
  assert.equal(clientInfo('x', '/p?q=1').location, '/p');
  assert.deepEqual(['loader', 'locate', 'mark'].map(stage => scriptInfo(stage, 'r').stage_label), ['加载主脚本', '找到正文', '标出词']);
  assert.equal(scriptInfo('mark', 'r', 'loc', false).retryable, false);
});

// ---- SSE: ported from the old browser tests; fetch is replaced by one answering with a ReadableStream ----
function fakeStream(pieces, {honourAbort = true, hang = false} = {}) {
  globalThis.fetch = (path, init) => {
    let cancelled = false;
    const stream = new ReadableStream({
      async start(controller) {
        init.signal?.addEventListener('abort', () => { if (honourAbort) controller.error(new DOMException('aborted', 'AbortError')); });
        for (const piece of pieces) {
          if (typeof piece === 'number') await new Promise(r => setTimeout(r, piece));
          else if (!cancelled) controller.enqueue(piece);
        }
        if (!hang && !cancelled) controller.close();
      },
      cancel() { cancelled = true; },
    });
    return Promise.resolve(new Response(stream, {status: 200, headers: {'content-type': 'text/event-stream'}}));
  };
}
const settle = (promise, ms = 2000) => Promise.race([promise.then(() => 'settled', error => 'rejected: ' + error.message), new Promise(r => setTimeout(() => r('hung'), ms))]);

test('the event parser handles chunked frames, comments and bad data', () => {
  const seen = [];
  const parser = sseParser((name, data) => seen.push([name, data]));
  parser.push(': ping\n\nevent: progress\nda');
  parser.push('ta: {"text":"1"}\n\nevent: x\ndata: nope\n\n');
  assert.equal(seen[0][0], 'progress');
  assert.deepEqual(seen[0][1], {text: '1'});
  assert.equal(seen[1][0], 'error');
  assert.equal(seen[1][1].reason, '服务器回应格式不对');
});

test('streamSSE reassembles frames from byte pieces split inside multibyte characters and CRLF', async () => {
  configure({base: 'https://a', token: 'T'});
  const bytes = new TextEncoder().encode(': ping\r\n\r\nevent: delta\r\ndata: {"text":"日本語"}\r\n\r\n: ping\r\n\r\nevent: delta\r\ndata: {"text":"ニュース"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n');
  const pieces = [];
  for (let i = 0; i < bytes.length; i++) { pieces.push(bytes.slice(i, i + 1)); if (i % 7 === 0) pieces.push(1); }
  fakeStream(pieces);
  const seen = [];
  await streamSSE('/api/news/ask', {}, {onEvent: (name, data) => seen.push([name, data])});
  assert.deepEqual(seen, [['delta', {text: '日本語'}], ['delta', {text: 'ニュース'}], ['done', {}]]);
});

test('streamSSE ends quietly when aborted while a read is pending', async () => {
  configure({base: 'https://a', token: 'T'});
  for (const honourAbort of [true, false]) {
    const first = new TextEncoder().encode('event: progress\ndata: {"text":"1"}\n\n');
    fakeStream([first], {honourAbort, hang: true}); // then the read waits forever
    const seen = [];
    const controller = new AbortController();
    const done = streamSSE('/api/news/ask', {}, {signal: controller.signal, onEvent: (name, data) => { seen.push([name, data]); setTimeout(() => controller.abort(), 30); }});
    assert.deepEqual({outcome: await settle(done), seen}, {outcome: 'settled', seen: [['progress', {text: '1'}]]}, `honourAbort=${honourAbort}`);
  }
});

test('streamSSE rejects when the handler throws and does not report an interrupted stream', async () => {
  configure({base: 'https://a', token: 'T'});
  const enc = text => new TextEncoder().encode(text);
  const out = {};
  for (const [label, body] of [['non-terminal', 'event: progress\ndata: {"text":"1"}\n\nevent: progress\ndata: {"text":"2"}\n\nevent: done\ndata: {}\n\n'], ['terminal', 'event: done\ndata: {}\n\n']]) {
    fakeStream([enc(body)]);
    const seen = [];
    const outcome = await settle(streamSSE('/api/news/ask', {}, {onEvent: name => { seen.push(name); throw new Error('handler bug'); }}));
    out[label] = {outcome, seen};
  }
  assert.deepEqual(out, {'non-terminal': {outcome: 'rejected: handler bug', seen: ['progress']}, terminal: {outcome: 'rejected: handler bug', seen: ['done']}});
});

test('streamSSE turns a 401 into an error event with the install link', async () => {
  configure({base: 'https://a', token: 'T'});
  globalThis.fetch = async () => json(401, {error: '请登录'});
  const seen = [];
  await streamSSE('/api/news/ask', {}, {onEvent: (name, data) => seen.push([name, data])});
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'error');
  assert.equal(seen[0][1].install, 'https://a/news-script/');
});

test('siteUrl gives a full address on the configured site', () => {
  configure({base: 'https://a/', token: 'T'});
  assert.equal(siteUrl('/grammar/#N3/5-5'), 'https://a/grammar/#N3/5-5');
});
