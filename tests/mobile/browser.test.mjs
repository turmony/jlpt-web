import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../mobile/package.json', import.meta.url));
const { webkit } = require('playwright');
const project = resolve(new URL('../..', import.meta.url).pathname);
const study = resolve(process.env.JLPT_STUDY_ROOT || project);
const site = resolve(process.env.JLPT_MOBILE_SITE || resolve(project, 'public'));
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let browser, server, url;

before(async () => {
  const { createImageProxy, imageManifest } = await import(pathToFileURL(resolve(site, '_worker.js')));
  const proxy = createImageProxy(imageManifest, { fetchUpstream: async upstream => {
    const asset = decodeURIComponent(new URL(upstream).pathname.split('/jlpt-notes/')[1]);
    assert.ok(asset?.startsWith('assets/grammar/'));
    return new Response(await readFile(resolve(study, 'jlpt-notes', asset)), { headers: { 'Content-Type': 'image/png' } });
  } });
  server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/jlpt-study\//, '');
      if (path.startsWith('images/')) {
        const result = await proxy.fetch(new Request('http://localhost/' + path, { method: request.method }));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      const file = resolve(site, path || 'index.html');
      if (!file.startsWith(site + '/')) throw new Error('outside');
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/jlpt-study/`;
  browser = await webkit.launch({ headless: true });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });

async function context(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, ...options });
  // The phone must only contact its own site; GitHub is contacted by the proxy.
  await ctx.route('https://raw.githubusercontent.com/**', route => route.abort());
  return ctx;
}
async function ready(page) {
  await page.goto(url);
  await page.waitForSelector('#start-reading:not([disabled])');
}
async function start(page) {
  await ready(page);
  await page.locator('#start').fill('31');
  await page.locator('#end').fill('40');
  await page.locator('#start-reading').click();
  await page.waitForFunction(() => document.getElementById('thumbnail-image').naturalWidth > 0);
}
async function open(page) {
  await page.locator('#thumbnail').click();
  await page.waitForSelector('#lightbox[open]');
  await page.waitForFunction(() => document.getElementById('full-image').naturalWidth > 0);
}
async function tap(page, fraction = .6) {
  const box = await page.locator('#image-stage').boundingBox();
  await page.touchscreen.tap(box.x + box.width * fraction, box.y + box.height / 2);
}

async function waitForCachedImages(page, expected) {
  const deadline = Date.now() + 10000;
  let count;
  do {
    count = await page.evaluate(async () => {
      const db = await new Promise(resolve => {
        const request = indexedDB.open('jlpt-image-cards:images', 1);
        request.onsuccess = () => resolve(request.result);
      });
      try {
        return await new Promise(resolve => {
          const request = db.transaction('metadata').objectStore('metadata').count();
          request.onsuccess = () => resolve(request.result);
        });
      } finally { db.close(); }
    });
    if (count === expected) return;
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  assert.equal(count, expected);
}

test('neighboring quick ranges fill inputs and persist their four numbers without starting reading', async () => {
  const ctx = await context();
  try {
    const page = await ctx.newPage();
    await ready(page);
    await page.evaluate(() => localStorage.setItem('jlpt-image-cards:last', JSON.stringify({ level: 'N1', start: 31, end: 40, id: 'N1-G-0035' })));
    await page.locator('#start').fill('41'); await page.locator('#end').fill('50');
    assert.equal(await page.locator('#quick-previous').textContent(), '31–40');
    assert.equal(await page.locator('#quick-next').textContent(), '51–60');
    assert.equal(await page.locator('.quick-ranges button').count(), 2);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('jlpt-image-cards:range-selection')));
    assert.deepEqual(stored.previous, [31, 40]); assert.deepEqual(stored.next, [51, 60]);
    await page.reload(); await page.waitForSelector('#start-reading:not([disabled])');
    assert.equal(await page.locator('#start').inputValue(), '41');
    assert.equal(await page.locator('#end').inputValue(), '50');
    assert.equal(await page.locator('#quick-previous').textContent(), '31–40');
    assert.equal(await page.locator('#quick-next').textContent(), '51–60');
    await page.locator('#quick-next').click();
    assert.equal(await page.locator('#start').inputValue(), '51');
    assert.equal(await page.locator('#end').inputValue(), '60');
    assert.equal(await page.locator('#quick-previous').textContent(), '41–50');
    assert.equal(await page.locator('#quick-next').textContent(), '61–70');
    await page.reload(); await page.waitForSelector('#start-reading:not([disabled])');
    assert.equal(await page.locator('#start').inputValue(), '51');
    assert.equal(await page.locator('#end').inputValue(), '60');
    await page.locator('#quick-previous').click();
    assert.equal(await page.locator('#start').inputValue(), '41');
    assert.equal(await page.locator('#end').inputValue(), '50');
    await page.locator('#start').fill('1'); await page.locator('#end').fill('10');
    assert.equal(await page.locator('#quick-previous').isDisabled(), true);
    assert.equal(await page.locator('#quick-next').textContent(), '11–20');
    await page.locator('#start').fill('');
    assert.equal(await page.locator('#quick-next').isDisabled(), true);
    await page.reload(); await page.waitForSelector('#start-reading:not([disabled])');
    assert.equal(await page.locator('#start').inputValue(), '1');
    assert.equal(await page.locator('#end').inputValue(), '10');
  } finally { await ctx.close(); }
});

test('quick ranges remain usable when local storage is unavailable', async () => {
  const ctx = await context();
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new Error('storage unavailable'); };
    });
    await ready(page);
    await page.locator('#start').fill('41'); await page.locator('#end').fill('50');
    await page.locator('#quick-previous').click();
    assert.equal(await page.locator('#start').inputValue(), '31');
    assert.equal(await page.locator('#end').inputValue(), '40');
  } finally { await ctx.close(); }
});

test('full core content scrolls in a fixed region and changes with the current card', async () => {
  for (const viewport of [{ width: 375, height: 667 }, { width: 320, height: 568 }]) {
    const ctx = await context({ viewport });
    try {
      const page = await ctx.newPage();
      const catalog = JSON.parse(await readFile(resolve(site, 'catalog.json'), 'utf8'));
      const shortCore = '完整的短核心内容。';
      const longCore = '核心例句与解释。\n'.repeat(100) + '<script>不得执行</script>\n核心最后一行。';
      catalog.cards.find(card => card.id === 'N1-G-0031').core = shortCore;
      catalog.cards.find(card => card.id === 'N1-G-0032').core = longCore;
      await page.route('**/catalog.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(catalog) }));
      await start(page);
      assert.equal(await page.locator('#card-title').count(), 0);
      assert.equal(await page.locator('#card-core').textContent(), shortCore);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const positions = () => page.evaluate(() => ['#jump-form label', '#jump', '#jump-form button'].map(selector => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      }));
      const baseline = await positions();
      await page.locator('#next').click();
      await page.waitForFunction(() => !document.getElementById('thumbnail-image').hidden);
      assert.equal((await page.locator('#card-core').textContent()).replace(/\s/g, ''), longCore.replace(/\s/g, ''));
      const overflow = await page.locator('#card-core').evaluate(element => {
        element.scrollTop = element.scrollHeight;
        return { height: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
      });
      assert.ok(overflow.scrollHeight > overflow.height);
      assert.ok(overflow.scrollTop > 0);
      assert.equal(await page.locator('#card-core script').count(), 0);
      assert.deepEqual(await positions(), baseline);
      await page.locator('#previous').click();
      await page.waitForFunction(() => !document.getElementById('thumbnail-image').hidden);
      assert.equal(await page.locator('#card-core').textContent(), shortCore);
      assert.equal(await page.locator('#card-core').evaluate(element => element.scrollTop), 0);
      assert.deepEqual(await positions(), baseline);
    } finally { await ctx.close(); }
  }
});

test('function navigation jumps inside the formatted core only and updates per card', async () => {
  const ctx = await context({ viewport: { width: 320, height: 568 } });
  try {
    const page = await ctx.newPage();
    const catalog = JSON.parse(await readFile(resolve(site, 'catalog.json'), 'utf8'));
    const core = ['## 功能一：完整解释一', '正文一。\n'.repeat(30).trim(), '## 功能二（接辞书形）：完整解释二', '正文二。\n'.repeat(30).trim(), '## 功能三：完整解释三', '正文三。\n'.repeat(30).trim()].join('\n\n\n');
    catalog.cards.find(card => card.id === 'N1-G-0031').core = core;
    catalog.cards.find(card => card.id === 'N1-G-0032').core = '## 功能一：新卡片\n\n全部内容。';
    catalog.cards.find(card => card.id === 'N1-G-0033').core = '## 普通说明\n\n无功能分组的核心。';
    await page.route('**/catalog.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(catalog) }));
    await start(page);
    assert.deepEqual(await page.locator('#core-navigation button').allTextContents(), ['功能一', '功能二', '功能三']);
    const visibleText = await page.locator('#card-core').textContent();
    assert.equal((visibleText.match(/正文[一二三]。/g) || []).length, 90);
    assert.equal(visibleText.includes('##'), false);
    assert.equal(await page.locator('#card-core').evaluate(element => getComputedStyle(element).lineHeight), '24px');
    const placement = await page.evaluate(() => ({
      previousBottom: document.querySelector('.card-navigation').getBoundingClientRect().bottom + scrollY,
      navigationTop: document.getElementById('core-navigation').getBoundingClientRect().top + scrollY,
      navigationBottom: document.getElementById('core-navigation').getBoundingClientRect().bottom + scrollY,
      coreTop: document.getElementById('core-heading').getBoundingClientRect().top + scrollY,
    }));
    assert.ok(placement.navigationTop >= placement.previousBottom);
    assert.ok(placement.navigationBottom <= placement.coreTop);
    await page.locator('#core-navigation').scrollIntoViewIfNeeded();
    const documentScroll = await page.evaluate(() => scrollY);
    await page.locator('#core-navigation button').nth(1).click();
    const position = await page.evaluate(() => {
      const core = document.getElementById('card-core');
      const target = core.querySelectorAll('[data-core-function]')[1];
      return { scrollTop: core.scrollTop, documentScroll: scrollY, offset: target.getBoundingClientRect().top - core.getBoundingClientRect().top };
    });
    assert.ok(position.scrollTop > 0);
    assert.equal(position.documentScroll, documentScroll);
    assert.ok(Math.abs(position.offset - 15) < 2);
    await page.locator('#core-navigation button').first().click();
    assert.equal(await page.locator('#card-core').evaluate(element => element.scrollTop), 0);
    await page.locator('#next').click();
    assert.deepEqual(await page.locator('#core-navigation button').allTextContents(), ['功能一']);
    assert.equal(await page.locator('#card-core').evaluate(element => element.scrollTop), 0);
    await page.locator('#next').click();
    assert.equal(await page.locator('#core-navigation').isVisible(), false);
    assert.equal(await page.locator('#core-navigation button').count(), 0);
    assert.equal(await page.locator('#card-core [data-core-function]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await ctx.close(); }
});

test('core uses readable headings, paragraph spacing and grouped examples without Markdown symbols', async () => {
  const ctx = await context({ viewport: { width: 320, height: 568 } });
  try {
    const page = await ctx.newPage();
    const catalog = JSON.parse(await readFile(resolve(site, 'catalog.json'), 'utf8'));
    catalog.cards.find(card => card.id === 'N1-G-0031').core = '## 功能一：**含义一**\n\n\n解释第一段。\n\n\n解释第二段。\n\n### 例句\n\n1. 日本語の例文。\n\n   （例句中文翻译。）\n\n2. 第二の例文。\n\n   （第二句中文翻译。）\n\n## 功能二：含义二\n\n完整结尾。\n\n| 项目 | 内容 |\n| --- | --- |\n| 接续 | 名词＋で |\n\n```text\n## 功能三：代码内容\n\n保留代码空行\n```';
    await page.route('**/catalog.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(catalog) }));
    await start(page);
    assert.deepEqual(await page.locator('#core-navigation button').allTextContents(), ['功能一', '功能二']);
    assert.equal(await page.locator('#card-core h2').first().textContent(), '功能一：含义一');
    assert.equal(await page.locator('#card-core h2 strong').textContent(), '含义一');
    assert.deepEqual(await page.locator('#card-core > p').allTextContents(), ['解释第一段。', '解释第二段。', '完整结尾。']);
    assert.deepEqual(await page.locator('#card-core li p').allTextContents(), ['日本語の例文。', '（例句中文翻译。）', '第二の例文。', '（第二句中文翻译。）']);
    assert.equal(await page.locator('#card-core table').count(), 1);
    assert.equal(await page.locator('#card-core pre code').textContent(), '## 功能三：代码内容\n\n保留代码空行\n');
    const spacing = await page.evaluate(() => {
      const core = document.getElementById('card-core');
      const style = selector => getComputedStyle(core.querySelector(selector));
      return { height: core.getBoundingClientRect().height, lineHeight: getComputedStyle(core).lineHeight,
        headingSize: style('h2').fontSize, headingWeight: style('h2').fontWeight,
        secondHeadingGap: getComputedStyle(core.querySelectorAll('h2')[1]).marginTop,
        paragraphGap: style('p').marginBottom, translationGap: style('li p').marginBottom,
        exampleGap: style('li + li').marginTop };
    });
    assert.deepEqual(spacing, { height: 240, lineHeight: '24px', headingSize: '16px', headingWeight: '600',
      secondHeadingGap: '12px', paragraphGap: '8px', translationGap: '4px', exampleGap: '8px' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await ctx.close(); }
});

test('legacy core groups nested translations and renders only safe HTML line breaks', async () => {
  const ctx = await context({ viewport: { width: 320, height: 568 } });
  try {
    const page = await ctx.newPage();
    const catalog = JSON.parse(await readFile(resolve(site, 'catalog.json'), 'utf8'));
    catalog.cards.find(card => card.id === 'N1-G-0031').core = '### 视频核心例句\n\n- 日语例句一。\n  - 中文：翻译一。\n- 日语例句二。\n  - 中文：翻译二。\n\n| 项目 | 内容 |\n| --- | --- |\n| 例句 | 日本語。<br>中文。<BR />结尾。 |\n\n<script>不得执行</script>\n\n<br onclick="alert(1)">';
    await page.route('**/catalog.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(catalog) }));
    await start(page);
    assert.equal(await page.locator('#card-core td br').count(), 2);
    assert.equal(await page.locator('#card-core td').last().textContent(), '日本語。中文。结尾。');
    assert.equal(await page.locator('#card-core script, #card-core [onclick]').count(), 0);
    assert.ok((await page.locator('#card-core').textContent()).includes('<br onclick="alert(1)">'));
    const nested = await page.locator('#card-core li > ul').first().evaluate(element => ({
      pairGap: getComputedStyle(element).marginTop, bottomGap: getComputedStyle(element).marginBottom,
    }));
    assert.deepEqual(nested, { pairGap: '4px', bottomGap: '0px' });
  } finally { await ctx.close(); }
});

test('selected range fetches twenty actual images and fits small iPhone', async () => {
  const ctx = await context();
  const page = await ctx.newPage();
  const requests = new Set();
  page.on('request', request => { if (request.url().includes('raw.githubusercontent.com') || request.url().includes('/assets/grammar/')) requests.add(request.url()); });
  await start(page);
  await page.waitForFunction(() => document.getElementById('card-id').textContent === 'N1-G-0031');
  const deadline = Date.now() + 5000;
  while (requests.size < 20 && Date.now() < deadline) await page.waitForTimeout(50);
  assert.equal(requests.size, 20);
  assert.ok([...requests].every(request => request.startsWith(url + 'images/')));
  assert.ok([...requests].every(url => /N1-G-00(3[1-9]|40)-(connection|example)\.png$/.test(url)));
  assert.equal(await page.locator('#card-progress').textContent(), '1 / 10');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/jlpt-mobile-reader.png', fullPage: true });
  await ctx.close();
});

test('image shape, long core content and failures keep the frame and navigation in place', async () => {
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    const ctx = await context({ viewport });
    try {
      const page = await ctx.newPage();
      const fixtures = await page.evaluate(() => {
        const picture = (width, height) => {
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').fillRect(0, 0, width, height);
          return canvas.toDataURL('image/png').split(',')[1];
        };
        return { wide: picture(900, 90), tall: picture(90, 900) };
      });
      const catalog = JSON.parse(await readFile(resolve(site, 'catalog.json'), 'utf8'));
      catalog.cards.find(card => card.id === 'N1-G-0031').core = '短核心内容';
      catalog.cards.find(card => card.id === 'N1-G-0032').core = '接续、意义与课程例句。\n'.repeat(100);
      catalog.cards.find(card => card.id === 'N1-G-0033').core = '图片失败时仍显示完整核心内容。';
      await page.route('**/catalog.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(catalog) }));
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      await page.route('**/*.png', async route => {
        const name = route.request().url();
        if (name.includes('0033-connection')) return route.abort();
        if (name.includes('0031-connection')) await pending;
        const encoded = name.includes('0032-connection') || name.includes('0031-example') ? fixtures.tall : fixtures.wide;
        await route.fulfill({ contentType: 'image/png', body: Buffer.from(encoded, 'base64') });
      });
      await ready(page);
      await page.locator('#end').fill('33');
      await page.locator('#start-reading').click();
      const positions = () => page.evaluate(() => Object.fromEntries(
        ['thumbnail', 'previous', 'next', 'card-core', 'jump', 'jump-button'].map(id => {
          const element = id === 'jump-button' ? document.querySelector('#jump-form button')
            : document.getElementById(id);
          const { x, y, width, height } = element.getBoundingClientRect();
          return [id, { x, y: y + scrollY, width, height }];
        }),
      ));
      const baseline = await positions();
      assert.equal(baseline['card-core'].height, 240, 'core content reserves a fixed height');
      const unchanged = async state => {
        const current = await positions();
        for (const id of Object.keys(baseline)) {
          for (const dimension of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(current[id][dimension] - baseline[id][dimension]) < 1,
              `${viewport.width}px ${state}: ${id}.${dimension} moved from ${baseline[id][dimension]} to ${current[id][dimension]}`);
          }
        }
      };
      release();
      await page.waitForFunction(() => !document.getElementById('thumbnail-image').hidden);
      await unchanged('wide image');
      await page.locator('#next').click();
      await page.waitForFunction(() => !document.getElementById('thumbnail-image').hidden);
      assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0032');
      await unchanged('tall image and long title');
      await open(page);
      const previous = await page.locator('#full-previous').boundingBox();
      const next = await page.locator('#full-next').boundingBox();
      await page.locator('#toggle-image').click();
      await page.waitForFunction(() => !document.getElementById('full-image').hidden);
      assert.deepEqual(await page.locator('#full-previous').boundingBox(), previous);
      assert.deepEqual(await page.locator('#full-next').boundingBox(), next);
      await page.locator('#close-lightbox').click();
      await page.locator('#next').click();
      await page.waitForSelector('#retry-thumbnail:not([hidden])');
      await unchanged('failed image and retry button');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await ctx.close(); }
  }
});

test('touch double tap switches image without moving to next card', async () => {
  const ctx = await context();
  const page = await ctx.newPage();
  await start(page); await open(page);
  await tap(page); await page.waitForTimeout(70); await tap(page);
  await page.waitForTimeout(380);
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0031');
  assert.equal(await page.locator('#lightbox-title').textContent(), 'N1-G-0031 · 例句');
  assert.match(await page.locator('#full-image').getAttribute('data-source'), /0031-example\.png/);
  await page.waitForFunction(() => !document.getElementById('full-image').hidden);
  await page.screenshot({ path: '/tmp/jlpt-mobile-full.png' });
  await tap(page); await page.waitForTimeout(380);
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0032');
  assert.equal(await page.locator('#lightbox-title').textContent(), 'N1-G-0032 · 接续');
  await tap(page, .09); await page.waitForTimeout(380);
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0031');
  await page.locator('#close-lightbox').click();
  await page.waitForSelector('#lightbox:not([open])', { state: 'attached' });
  assert.equal(await page.locator('#reader').isVisible(), true);
  await ctx.close();
});

test('jump, saved progress, browser back and range boundaries', async () => {
  const ctx = await context(); const page = await ctx.newPage();
  await start(page);
  assert.equal(await page.locator('#previous').isDisabled(), true);
  await page.locator('#jump').fill('40'); await page.locator('#jump-form button').click();
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0040');
  assert.equal(await page.locator('#next').isDisabled(), true);
  await page.locator('#jump').fill('41'); await page.locator('#jump-form button').click();
  assert.match(await page.locator('#jump-error').textContent(), /区间/);
  await page.reload(); await page.waitForSelector('#resume:not([hidden])');
  await page.locator('#resume').click();
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0040');
  await open(page); await page.goBack();
  assert.equal(await page.locator('#lightbox').evaluate(el => el.open), false);
  assert.equal(await page.locator('#reader').isVisible(), true);
  await page.goBack(); assert.equal(await page.locator('#setup').isVisible(), true);
  await ctx.close();
});

test('landscape image is contained and reduced motion does not overflow', async () => {
  const ctx = await context({ viewport: { width: 812, height: 375 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage(); await start(page); await open(page);
  const stage = await page.locator('#image-stage').boundingBox();
  const image = await page.locator('#full-image').boundingBox();
  assert.ok(image.height <= stage.height + 1);
  assert.ok(stage.height > 150);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/jlpt-mobile-landscape.png' });
  await ctx.close();
});

test('missing N5 images and invalid range show clear feedback', async () => {
  const ctx = await context(); const page = await ctx.newPage(); await ready(page);
  await page.locator('label:has(input[value="N5"])').click();
  await page.locator('#start-reading').click();
  assert.match(await page.locator('#range-error').textContent(), /图片/);
  await page.locator('label:has(input[value="N1"])').click();
  await page.locator('#start').fill('40'); await page.locator('#end').fill('31');
  await page.locator('#start-reading').click();
  assert.match(await page.locator('#range-error').textContent(), /结束编号/);
  await ctx.close();
});

test('failed catalog and image can be retried without losing selection', async () => {
  const ctx = await context(); const page = await ctx.newPage();
  let failCatalog = true;
  await page.route('**/catalog.json', route => failCatalog ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue());
  await page.goto(url); await page.waitForSelector('#catalog-error:not([hidden])');
  assert.equal(await page.locator('#start-reading').isDisabled(), true);
  failCatalog = false; await page.locator('#reload-catalog').click();
  await page.waitForSelector('#start-reading:not([disabled])');
  let failImage = true;
  await page.route('**/*0031-connection.png*', route => failImage ? route.abort() : route.fallback());
  await page.locator('#start-reading').click();
  await page.waitForSelector('#retry-thumbnail:not([hidden])');
  assert.match(await page.locator('#thumbnail-status').textContent(), /加载失败/);
  failImage = false; await page.locator('#retry-thumbnail').click();
  await page.waitForFunction(() => !document.getElementById('thumbnail-image').hidden);
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0031');
  await ctx.close();
});

test('a stalled image times out and retry keeps the selected card', async () => {
  const ctx = await context(); const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.shortenImageTimeout = true;
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => schedule(callback, window.shortenImageTimeout && delay === 20000 ? 150 : delay, ...args);
  });
  await ready(page);
  let stalled = true;
  await page.route('**/*0031-connection.png*', async route => {
    if (stalled) return; // Leave the request pending until the display timeout.
    await route.fallback();
  });
  await page.locator('#start-reading').click();
  await page.waitForSelector('#retry-thumbnail:not([hidden])', { timeout: 2000 });
  assert.match(await page.locator('#thumbnail-status').textContent(), /超时/);
  stalled = false;
  await page.evaluate(() => { window.shortenImageTimeout = false; });
  await page.locator('#retry-thumbnail').click();
  await page.waitForFunction(() => !document.getElementById('thumbnail-image').hidden);
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0031');
  await ctx.close();
});

test('drag and multiple fingers do not trigger tap navigation', async () => {
  const ctx = await context(); const page = await ctx.newPage(); await start(page); await open(page);
  const stage = page.locator('#image-stage');
  await stage.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 200 });
  await stage.dispatchEvent('pointermove', { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 150, clientY: 200 });
  await stage.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 150, clientY: 200 });
  await page.waitForTimeout(380);
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0031');
  await stage.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 200 });
  await stage.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 150, clientY: 200 });
  await stage.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 200 });
  await stage.dispatchEvent('pointerup', { pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 150, clientY: 200 });
  await page.waitForTimeout(380);
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0031');
  await ctx.close();
});

test('a longer second touch switches images instead of triggering two singles', async () => {
  const ctx = await context(); const page = await ctx.newPage(); await start(page); await open(page);
  const stage = page.locator('#image-stage');
  const box = await stage.boundingBox();
  const point = { pointerId: 77, pointerType: 'touch', isPrimary: true,
    clientX: box.x + box.width * .6, clientY: box.y + box.height / 2 };
  await tap(page); await page.waitForTimeout(220);
  await stage.dispatchEvent('pointerdown', point); await page.waitForTimeout(120);
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0031');
  await stage.dispatchEvent('pointerup', point); await page.waitForTimeout(380);
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0031');
  assert.equal(await page.locator('#lightbox-title').textContent(), 'N1-G-0031 · 例句');
  await ctx.close();
});

test('back after reload restores the original range rather than the newest session', async () => {
  const ctx = await context(); const page = await ctx.newPage(); await start(page); await open(page);
  await page.reload(); await page.waitForSelector('#start-reading:not([disabled])');
  await page.locator('#start').fill('1'); await page.locator('#end').fill('10');
  await page.locator('#start-reading').click();
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0001');
  await page.goBack(); await page.goBack();
  assert.match(page.url(), /#N1\/31-40$/);
  assert.equal(await page.locator('#range-label').textContent(), 'N1 · 31–40');
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0031');
  await ctx.close();
});

test('the same range survives reload without downloading its cached images again', async () => {
  const ctx = await context(); const page = await ctx.newPage(); await start(page);
  await waitForCachedImages(page, 20);
  let downloads = 0;
  await page.route('**/*.png', route => { downloads++; return route.abort(); });
  await page.reload(); await page.waitForSelector('#resume:not([hidden])');
  await page.locator('#resume').click();
  await page.waitForFunction(() => !document.getElementById('thumbnail-image').hidden);
  await open(page); await page.locator('#toggle-image').click();
  await page.waitForFunction(() => !document.getElementById('full-image').hidden);
  assert.equal(downloads, 0);
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0031');
  await ctx.close();
});

test('returning to a page the next day clears pictures and preserves the reading position', async () => {
  const ctx = await context(); const page = await ctx.newPage();
  await page.addInitScript(() => {
    const NativeDate = Date;
    window.dayShift = 0;
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [NativeDate.now() + window.dayShift])); }
      static now() { return NativeDate.now() + window.dayShift; }
    };
  });
  await start(page);
  await waitForCachedImages(page, 20);
  await page.locator('#jump').fill('35'); await page.locator('#jump-form button').click();
  await page.waitForFunction(() => !document.getElementById('thumbnail-image').hidden);
  const saved = await page.evaluate(() => localStorage.getItem('jlpt-image-cards:last'));
  const selection = await page.evaluate(() => localStorage.getItem('jlpt-image-cards:range-selection'));
  await page.evaluate(() => { window.dayShift = 86400000; document.dispatchEvent(new Event('visibilitychange')); });
  await waitForCachedImages(page, 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('jlpt-image-cards:last')), saved);
  assert.equal(await page.evaluate(() => localStorage.getItem('jlpt-image-cards:range-selection')), selection);
  assert.equal(await page.locator('#card-id').textContent(), 'N1-G-0035');
  await ctx.close();
});
