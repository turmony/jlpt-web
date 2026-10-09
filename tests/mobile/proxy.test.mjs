import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageProxy } from '../../mobile/image-proxy.mjs';

const path = '/images/commit/assets/grammar/n1/接续 图.png';
const upstream = 'https://raw.githubusercontent.com/turmony/jlpt-study/commit/jlpt-notes/assets/grammar/n1/%E6%8E%A5%E7%BB%AD%20%E5%9B%BE.png';
const manifest = { [path]: upstream };
const request = (target = path, method = 'GET') => new Request('https://cards.test' + target, { method });

test('only an explicit request downloads the allowlisted image with no browser cache', async () => {
  const calls = [];
  const worker = createImageProxy(manifest, { fetchUpstream: async (url, options) => {
    calls.push({ url, options });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
  } });
  assert.equal(calls.length, 0);
  const response = await worker.fetch(request());
  assert.equal(response.status, 200);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(calls[0].url, upstream);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('uses a redirect mode supported by the Cloudflare edge runtime', async () => {
  const worker = createImageProxy(manifest, { fetchUpstream: async (_, options) => {
    // workerd rejects redirect: error before any network request.
    if (!['follow', 'manual'].includes(options.redirect)) throw new TypeError('Invalid redirect value');
    return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } });
  } });
  assert.equal((await worker.fetch(request())).status, 200);
});

test('unknown paths, malformed URLs and unsupported methods never contact GitHub', async () => {
  const worker = createImageProxy(manifest, { fetchUpstream: () => { throw new Error('must not fetch'); } });
  assert.equal((await worker.fetch(request('/images/commit/assets/unknown.png'))).status, 404);
  assert.equal((await worker.fetch(request('/images/%ZZ'))).status, 400);
  const response = await worker.fetch(request(path, 'POST'));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  assert.equal((await worker.fetch(request('/images/commit/assets/../secret'))).status, 404);
});

test('HEAD returns image headers without a body', async () => {
  let method;
  const worker = createImageProxy(manifest, { fetchUpstream: async (_, options) => {
    method = options.method;
    return new Response(null, { headers: { 'Content-Type': 'image/png' } });
  } });
  const response = await worker.fetch(request(path, 'HEAD'));
  assert.equal(method, 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('missing images, upstream failures and non-image responses fail without caching', async () => {
  for (const [source, expected] of [
    [new Response('missing', { status: 404 }), 404],
    [new Response('unavailable', { status: 503 }), 502],
    [new Response('html', { headers: { 'Content-Type': 'text/html' } }), 502],
    [new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }), 502],
  ]) {
    const response = await createImageProxy(manifest, { fetchUpstream: async () => source }).fetch(request());
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  const response = await createImageProxy(manifest, { fetchUpstream: async () => { throw new TypeError('network'); } }).fetch(request());
  assert.equal(response.status, 502);
});

test('a stalled upstream or response body times out and aborts the download', async () => {
  for (const headersOnly of [false, true]) {
    let signal;
    const worker = createImageProxy(manifest, { timeoutMs: 20, fetchUpstream: async (_, options) => {
      signal = options.signal;
      return headersOnly
        ? new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'image/png' } })
        : new Promise(() => {});
    } });
    const response = await worker.fetch(request());
    assert.equal(response.status, 504);
    assert.equal(signal.aborted, true);
  }
});

test('static requests use Cloudflare ASSETS without contacting GitHub', async () => {
  const worker = createImageProxy(manifest, { fetchUpstream: () => { throw new Error('must not fetch'); } });
  const response = await worker.fetch(request('/catalog.json'), {
    ASSETS: { fetch: async req => new Response(new URL(req.url).pathname) },
  });
  assert.equal(await response.text(), '/catalog.json');
});
