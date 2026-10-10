import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const require = createRequire(new URL('../../mobile/package.json', import.meta.url));
const { webkit } = require('playwright');
const project = resolve(new URL('../..', import.meta.url).pathname);
const study = resolve(process.env.JLPT_STUDY_ROOT || project);
let browser, server, url;
before(async () => {
  server = createServer(async (req, res) => {
    const path = resolve(project, 'mobile', '.' + new URL(req.url, 'http://localhost').pathname);
    try {
      if (!path.startsWith(resolve(project, 'mobile') + '/')) throw new Error('outside');
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': extname(path) === '.mjs' ? 'text/javascript' : 'text/html' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await webkit.launch();
});
after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); });

async function pageForTest() {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.route('**/empty.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto(url + '/empty.html');
  assert.equal(await page.evaluate(async () => (await fetch('/image-cache.mjs')).status), 200, 'cache module is published');
  return { ctx, page };
}

test('daily image cache persists across reloads and removes yesterday without touching progress', async () => {
  const { ctx, page } = await pageForTest();
  await page.evaluate(async () => {
    const { createImageCache } = await import('/image-cache.mjs');
    const cache = createImageCache({ now: () => new Date(2026, 9, 9, 20) });
    await cache.put('revision-a|image.png', new Blob(['today']));
    localStorage.setItem('jlpt-image-cards:last', 'reading position');
  });
  await page.reload();
  assert.deepEqual(await page.evaluate(async () => {
    const { createImageCache } = await import('/image-cache.mjs');
    let date = new Date(2026, 9, 9, 23, 59);
    const cache = createImageCache({ now: () => date });
    const today = await (await cache.get('revision-a|image.png')).text();
    date = new Date(2026, 9, 10, 0, 1);
    await cache.clearExpired();
    return { today, expired: await cache.get('revision-a|image.png'), stats: await cache.stats(), progress: localStorage.getItem('jlpt-image-cards:last') };
  }), { today: 'today', expired: null, stats: { entries: 0, bytes: 0 }, progress: 'reading position' });
  await ctx.close();
});

test('cache evicts the least recently read image and stays below its byte limit', async () => {
  const { ctx, page } = await pageForTest();
  assert.deepEqual(await page.evaluate(async () => {
    const { createImageCache } = await import('/image-cache.mjs');
    let ticks = new Date(2026, 9, 9).getTime();
    const cache = createImageCache({ maxBytes: 8, now: () => new Date(ticks++) });
    await cache.put('a', new Blob(['aaaa'])); await cache.put('b', new Blob(['bbbb']));
    await cache.get('a'); await cache.put('c', new Blob(['cccc']));
    return { a: !!(await cache.get('a')), b: await cache.get('b'), c: !!(await cache.get('c')), stats: await cache.stats(), oversized: await cache.put('huge', new Blob(['123456789'])) };
  }), { a: true, b: null, c: true, stats: { entries: 2, bytes: 8 }, oversized: false });
  await ctx.close();
});

test('cache overwrites entries without double counting and prunes expired data before reads', async () => {
  const { ctx, page } = await pageForTest();
  assert.deepEqual(await page.evaluate(async () => {
    const { createImageCache } = await import('/image-cache.mjs');
    let day = new Date(2026, 9, 9);
    const cache = createImageCache({ now: () => day });
    await Promise.all([cache.put('a', new Blob(['123'])), cache.put('b', new Blob(['456']))]);
    await cache.put('a', new Blob(['xx'])); const before = await cache.stats();
    day = new Date(2026, 9, 10); const expired = await cache.get('a');
    await cache.put('today', new Blob(['today']));
    return { before, expired, after: await cache.stats() };
  }), { before: { entries: 2, bytes: 5 }, expired: null, after: { entries: 1, bytes: 5 } });
  await ctx.close();
});

test('disabled storage degrades to downloads and does not reject cache operations', async () => {
  const { ctx, page } = await pageForTest();
  assert.deepEqual(await page.evaluate(async () => {
    const { createImageCache } = await import('/image-cache.mjs');
    const cache = createImageCache({ indexedDB: null });
    return { image: await cache.get('a'), stored: await cache.put('a', new Blob(['image'])), stats: await cache.stats() };
  }), { image: null, stored: false, stats: { entries: 0, bytes: 0 } });
  await ctx.close();
});

test('loader shares a concurrent download, reuses the day cache and isolates source revisions', async () => {
  const { ctx, page } = await pageForTest();
  let requests = 0;
  const body = await readFile(resolve(study, 'jlpt-notes/assets/grammar/n1/N1-G-0031-connection.png'));
  await page.route('**/image.png', route => { requests++; return route.fulfill({ contentType: 'image/png', body }); });
  assert.deepEqual(await page.evaluate(async () => {
    const { createImageLoader } = await import('/image-loader.mjs');
    const loader = createImageLoader();
    const [a, b] = await Promise.all([loader.load('/image.png', 'revision-a'), loader.load('/image.png', 'revision-a')]);
    await loader.load('/image.png', 'revision-a');
    await loader.load('/image.png', 'revision-b');
    return { same: a === b, type: a.type };
  }), { same: true, type: 'image/png' });
  assert.equal(requests, 2);
  await ctx.close();
});

test('a failed download or invalid image does not enter the cache and can be retried', async () => {
  const { ctx, page } = await pageForTest();
  let requests = 0;
  const body = await readFile(resolve(study, 'jlpt-notes/assets/grammar/n1/N1-G-0031-connection.png'));
  await page.route('**/image.png', route => {
    requests++;
    return requests === 1 ? route.fulfill({ status: 503, body: 'unavailable' })
      : requests === 2 ? route.fulfill({ contentType: 'image/png', body: 'not an image' })
      : route.fulfill({ contentType: 'image/png', body });
  });
  assert.deepEqual(await page.evaluate(async () => {
    const { createImageCache } = await import('/image-cache.mjs');
    const { createImageLoader } = await import('/image-loader.mjs');
    const cache = createImageCache(); const loader = createImageLoader({ cache });
    const results = [];
    for (let i = 0; i < 3; i++) {
      try { await loader.load('/image.png', 'revision-a'); results.push(true); } catch { results.push(false); }
    }
    return { results, entries: (await cache.stats()).entries };
  }), { results: [false, false, true], entries: 1 });
  assert.equal(requests, 3);
  await ctx.close();
});

test('a competing storage transaction cannot block downloads or retries', async () => {
  const { ctx, page } = await pageForTest();
  const body = await readFile(resolve(study, 'jlpt-notes/assets/grammar/n1/N1-G-0031-connection.png'));
  let requests = 0;
  await page.route('**/image.png', route => { requests++; return route.fulfill({ contentType: 'image/png', body }); });
  assert.deepEqual(await page.evaluate(async () => {
    const { createImageCache } = await import('/image-cache.mjs');
    const { createImageLoader } = await import('/image-loader.mjs');
    const cache = createImageCache({ timeoutMs: 80 });
    await cache.put('initial', new Blob(['initial']));
    const db = await new Promise(resolve => { const r = indexedDB.open('jlpt-image-cards:images'); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction(['images', 'metadata'], 'readwrite');
    let hold = true;
    const loop = () => { const r = tx.objectStore('metadata').get('initial'); r.onsuccess = () => { if (hold) loop(); }; };
    loop();
    try {
      const loader = createImageLoader({ cache });
      const outcome = await Promise.race([
        loader.load('/image.png', 'revision-a').then(() => 'downloaded'),
        new Promise(resolve => setTimeout(() => resolve('blocked'), 1000)),
      ]);
      if (outcome === 'blocked') return { outcome, retry: false };
      const image = await loader.load('/image.png', 'revision-a', { retry: true });
      return { outcome, retry: image.type === 'image/png' };
    } finally { hold = false; db.close(); }
  }), { outcome: 'downloaded', retry: true });
  assert.equal(requests, 2);
  await ctx.close();
});

test('explicit retry replaces a still-pending image request', async () => {
  const { ctx, page } = await pageForTest();
  const body = await readFile(resolve(study, 'jlpt-notes/assets/grammar/n1/N1-G-0031-connection.png'));
  let requests = 0;
  await page.route('**/retry.png', route => {
    requests++;
    if (requests === 1) return;
    return route.fulfill({ contentType: 'image/png', body });
  });
  const result = await page.evaluate(async () => {
    const { createImageLoader } = await import('/image-loader.mjs');
    const loader = createImageLoader();
    loader.load('/retry.png', 'revision-a').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    return Promise.race([
      loader.load('/retry.png', 'revision-a', { retry: true }).then(blob => blob.type === 'image/png'),
      new Promise(resolve => setTimeout(() => resolve(false), 2500)),
    ]);
  });
  assert.equal(result, true, 'retry should start a new download while the old one is pending');
  assert.equal(requests, 2);
  await ctx.close();
});
