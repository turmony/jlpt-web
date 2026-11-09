import test from 'node:test';
import assert from 'node:assert/strict';
import {configure, siteUrl, getJSON, postJSON, streamSSE, sseParser, NewsFailure, clientInfo, scriptInfo} from '../../news-client/api.mjs';

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const json = (status, body) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

test('requests go to base and carry no credentials', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init]); return json(200, {ok: true}); };
  configure({base: 'https://a'});
  assert.deepEqual(await getJSON('/api/news/models'), {ok: true});
  assert.equal(calls[0][0], 'https://a/api/news/models');
  await postJSON('/api/news/settings', {model: 'm'});
  assert.equal(calls[1][0], 'https://a/api/news/settings');
  assert.equal(calls[1][1].headers['Content-Type'], 'application/json');
  for (const [, init] of calls) assert.equal(init && init.headers && init.headers.Authorization, undefined);
});

test('a 401 is an ordinary server failure with no reinstall link', async () => {
  configure({base: 'https://a'});
  globalThis.fetch = async () => json(401, {error: '请登录'});
  await assert.rejects(getJSON('/api/news/models'), error => {
    assert.ok(error instanceof NewsFailure);
    assert.equal(error.info.reason, '服务器返回 401：请登录');
    assert.equal(error.info.stage_label, '脚本→服务器');
    assert.equal(error.info.location, '/api/news/models');
    assert.equal(error.info.install, undefined);
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
  configure({base: 'https://a'});
  const bytes = new TextEncoder().encode(': ping\r\n\r\nevent: delta\r\ndata: {"text":"日本語"}\r\n\r\n: ping\r\n\r\nevent: delta\r\ndata: {"text":"ニュース"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n');
  const pieces = [];
  for (let i = 0; i < bytes.length; i++) { pieces.push(bytes.slice(i, i + 1)); if (i % 7 === 0) pieces.push(1); }
  fakeStream(pieces);
  const seen = [];
  await streamSSE('/api/news/ask', {}, {onEvent: (name, data) => seen.push([name, data])});
  assert.deepEqual(seen, [['delta', {text: '日本語'}], ['delta', {text: 'ニュース'}], ['done', {}]]);
});

test('streamSSE ends quietly when aborted while a read is pending', async () => {
  configure({base: 'https://a'});
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
  configure({base: 'https://a'});
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

test('streamSSE turns a 401 into an error event with no install link', async () => {
  configure({base: 'https://a'});
  globalThis.fetch = async () => json(401, {error: '请登录'});
  const seen = [];
  await streamSSE('/api/news/ask', {}, {onEvent: (name, data) => seen.push([name, data])});
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'error');
  assert.equal(seen[0][1].install, undefined);
});

test('siteUrl gives a full address on the configured site', () => {
  configure({base: 'https://a/'});
  assert.equal(siteUrl('/grammar/#N3/5-5'), 'https://a/grammar/#N3/5-5');
});

// ---- Resumable streams: the server ends a connection with `resume` after ~12 s (the public edge cuts at 16 s) ----
const frame = (id, name, data) => `${id == null ? '' : `id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

// Answers the fetches one by one. Each answer: {frames: string, job: 'j1', status, drop: bool (error the body)}.
function scripted(answers) {
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({url, body: init.body ? JSON.parse(init.body) : null, init});
    if (String(url).endsWith('/api/news/cancel')) return Promise.resolve(json(200, {}));
    const answer = answers[Math.min(calls.filter(c => !String(c.url).endsWith('/cancel')).length - 1, answers.length - 1)];
    if (answer.error) return Promise.reject(new TypeError('network'));
    if (answer.status && answer.status !== 200) return Promise.resolve(json(answer.status, answer.json));
    const headers = {'content-type': 'text/event-stream'};
    if (answer.job) headers['X-News-Job'] = answer.job;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(answer.frames));
        // a real dropped connection delivers what arrived before it breaks; erroring at once would discard it
        if (answer.drop) setTimeout(() => controller.error(new TypeError('connection lost')), 10); else controller.close();
      },
    });
    return Promise.resolve(new Response(stream, {status: 200, headers}));
  };
  return calls;
}
const collect = async (path = '/api/news/analyze', body = {q: 1}, options = {}) => {
  const seen = [];
  await streamSSE(path, body, {onEvent: (name, data) => seen.push([name, data]), ...options});
  return seen;
};

test('a stream that ends in resume is continued from the last event number, invisibly', async () => {
  configure({base: 'https://a'});
  const calls = scripted([
    {job: 'j1', frames: frame(1, 'progress', {text: 'a'}) + frame(2, 'translation', {text: 't'}) + 'event: resume\ndata: {}\n\n'},
    {job: 'j1', frames: frame(3, 'grammar', {form: 'g'}) + frame(4, 'done', {analysis_text: 'x'})},
  ]);
  const seen = await collect();
  assert.deepEqual(seen, [['progress', {text: 'a'}], ['translation', {text: 't'}], ['grammar', {form: 'g'}], ['done', {analysis_text: 'x'}]]);
  assert.deepEqual(calls.map(c => [c.url, c.body]), [['https://a/api/news/analyze', {q: 1}], ['https://a/api/news/resume', {job: 'j1', next: 2}]]);
});

test('a long answer can take many connections', async () => {
  configure({base: 'https://a'});
  const resume = 'event: resume\ndata: {}\n\n';
  const calls = scripted([
    {job: 'j', frames: frame(1, 'progress', {}) + resume}, {job: 'j', frames: resume}, {job: 'j', frames: frame(2, 'translation', {}) + resume},
    {job: 'j', frames: frame(3, 'done', {})},
  ]);
  assert.deepEqual((await collect()).map(e => e[0]), ['progress', 'translation', 'done']);
  assert.deepEqual(calls.slice(1).map(c => c.body.next), [1, 1, 2]);
});

test('a connection lost mid-stream is resumed when the job is known', async () => {
  configure({base: 'https://a'});
  const calls = scripted([
    {job: 'j1', drop: true, frames: frame(1, 'progress', {text: 'a'}) + frame(2, 'translation', {text: 't'})},
    {job: 'j1', frames: frame(3, 'done', {})},
  ]);
  assert.deepEqual((await collect()).map(e => e[0]), ['progress', 'translation', 'done']);
  assert.equal(calls[1].body.next, 2);
});

test('events the client has already seen are not delivered twice', async () => {
  configure({base: 'https://a'});
  scripted([
    {job: 'j', frames: frame(1, 'progress', {}) + frame(2, 'grammar', {form: 'a'}) + 'event: resume\ndata: {}\n\n'},
    {job: 'j', frames: frame(2, 'grammar', {form: 'a'}) + frame(3, 'done', {})},
  ]);
  assert.deepEqual((await collect()).map(e => e[0]), ['progress', 'grammar', 'done']);
});

test('a lost connection is retried a few times, then reported as an interrupted answer', async () => {
  configure({base: 'https://a'});
  const calls = scripted([{job: 'j', drop: true, frames: frame(1, 'progress', {})}, {error: true}]);
  const seen = await collect();
  assert.deepEqual(seen.map(e => e[0]), ['progress', 'error']);
  assert.equal(seen[1][1].stage, 'stream');
  assert.equal(seen[1][1].reason, '回答中断');
  assert.ok(calls.length >= 3 && calls.length <= 6, `calls=${calls.length}`);
});

test('without a job name a lost stream is reported at once, as before', async () => {
  configure({base: 'https://a'});
  const calls = scripted([{drop: true, frames: frame(1, 'progress', {})}]);
  const seen = await collect();
  assert.deepEqual(seen.map(e => e[0]), ['progress', 'error']);
  assert.equal(calls.length, 1);
});

test('a job the server no longer has is an error the server explains', async () => {
  configure({base: 'https://a'});
  const info = {stage: 'stream', stage_label: '推送到网页', location: '', reason: '这次回答已过期，请重试', retryable: true, request_id: 'n-1', time: '10:00:00'};
  scripted([{job: 'j', frames: frame(1, 'progress', {}) + 'event: resume\ndata: {}\n\n'}, {status: 502, json: {error: info}}]);
  const seen = await collect();
  assert.deepEqual(seen, [['progress', {}], ['error', info]]);
});

test('aborting tells the server to stop the job, once it is known and unfinished', async () => {
  configure({base: 'https://a'});
  const calls = scripted([{job: 'j1', frames: frame(1, 'progress', {})}]);
  const controller = new AbortController();
  let abortedAt = 0;
  const done = collect('/api/news/analyze', {}, {signal: controller.signal, onEvent: () => { if (!abortedAt) { abortedAt = 1; setTimeout(() => controller.abort(), 20); } }});
  // the scripted stream closes without an end: the client resumes; the abort arrives meanwhile
  assert.equal(await settle(done, 3000), 'settled');
  const cancel = calls.find(c => c.url === 'https://a/api/news/cancel');
  assert.ok(cancel, 'cancel was sent');
  assert.deepEqual(cancel.body, {job: 'j1'});
  assert.equal(cancel.init.keepalive, true);
});

test('a finished stream sends no cancel when aborted afterwards', async () => {
  configure({base: 'https://a'});
  const calls = scripted([{job: 'j1', frames: frame(1, 'done', {})}]);
  const controller = new AbortController();
  await collect('/api/news/analyze', {}, {signal: controller.signal});
  controller.abort();
  assert.equal(calls.some(c => c.url.endsWith('/cancel')), false);
});

test('the event parser reports the id of a frame', () => {
  const seen = [];
  sseParser((name, data, id) => seen.push([name, id])).push('id: 7\nevent: grammar\ndata: {}\n\nevent: resume\ndata: {}\n\n');
  assert.deepEqual(seen, [['grammar', 7], ['resume', undefined]]);
});
