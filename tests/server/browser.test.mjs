import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(new URL('../../mobile/package.json',import.meta.url));
const {chromium,webkit,devices}=require('playwright');

async function withSite(engine,options,run) {
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-site-'));
  const server=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{server.stdout.once('data',data=>resolve(data.toString().trim()));server.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await engine.launch();
    const page=await (await browser.newContext(options)).newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url+'/login.html');
    await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();
    await page.waitForURL(url+'/review/');
    await run(page,url,tmp);
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();server.kill();await rm(tmp,{recursive:true,force:true});}
}

test('home and login open the review plan; grammar page links back',()=>withSite(chromium,{},async(page,url)=>{
  await page.goto(url+'/');await page.waitForURL(url+'/review/');
  await page.goto(url+'/login.html');await page.waitForURL(url+'/review/');
  await page.goto(url+'/grammar/');
  await page.locator('#start-reading:not([disabled])').waitFor();
  assert.equal(await page.getByRole('link',{name:'今日安排'}).getAttribute('href'),'/review/');
  assert.equal(await page.getByRole('link',{name:'做题'}).getAttribute('href'),'/papers.html');
  assert.equal(await page.getByRole('link',{name:'云开发'}).getAttribute('href'),'/code/');
  assert.equal((await page.goto(url+'/practice.html')).status(),404);
}));

for(const device of ['iPhone SE','iPhone 13','Desktop Chrome']) {
  test(`grammar page navigation leaves the header readable on ${device}`,()=>withSite(chromium,{...devices[device],locale:'zh-CN'},async(page,url)=>{
    const covers=selector=>page.evaluate(selector=>{
      const nav=document.querySelector('.shell > nav').getBoundingClientRect();
      return [...document.querySelectorAll(selector)].some(node=>{const box=node.getBoundingClientRect();return box.width>0&&nav.left<box.right&&box.left<nav.right&&nav.top<box.bottom&&box.top<nav.bottom;});
    },selector);
    await page.goto(url+'/grammar/');await page.locator('#start-reading:not([disabled])').waitFor();
    assert.equal(await covers('.brand span, .brand svg'),false);
    await page.locator('#start-reading').click();await page.locator('#change-range').waitFor();
    assert.equal(await covers('#change-range, #range-label'),false);
  }));
}

test('damaged study data shows the server error instead of a blank page',()=>withSite(chromium,{},async(page,url,tmp)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  const folder=join(tmp,'study/jlpt-notes/groups/submissions/r1');
  await mkdir(folder,{recursive:true});await writeFile(join(folder,'B-01-1.json'),'{');
  await page.reload();
  await page.locator('#notice',{hasText:'groups/submissions/r1/B-01-1.json'}).waitFor();
}));

for(const [name,engine] of Object.entries({chromium,webkit})) {
  test(`${name}: a unit is learned end to end on a phone`,()=>withSite(engine,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
    await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
    await page.getByRole('button',{name:'开始'}).click();
    await page.locator('#recall').waitFor();
    assert.equal(await page.locator('#unit-page').count(),0);
    await page.locator('#recall').fill('に：时间');
    await page.getByRole('button',{name:'锁定回忆'}).click();
    await page.locator('#unit-page img').first().waitFor();
    assert.equal(await page.locator('#unit-page img').first().evaluate(image=>image.complete&&image.naturalWidth>0),true);
    await page.locator('#unit-page a[href="#card-N5-G-0032"]').click();
    assert.equal(await page.locator('#card-N5-G-0032').evaluate(details=>details.open),true);
    await page.locator('.option-list').first().locator('.option-block').nth(1).click();
    await page.locator('#sentence').fill('三時に会いましょう。');
    page.on('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'交卷'}).click();
    await page.locator('#status',{hasText:'已交卷，待判分'}).waitFor();
    await page.locator('#progress-summary',{hasText:'已学 1 / 2'}).waitFor();
    const sub=JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/submissions/r1/B-01-1.json'),'utf8'));
    assert.equal(sub.recall.text,'に：时间');
    assert.equal(sub.sentence.text,'三時に会いましょう。');
    const paper=await readFile(join(tmp,'study/jlpt-notes/quizzes/papers/2026-10-17-b-01-1.md'),'utf8');
    assert.match(paper,/```text\n1-2, 2-__, 3-__, 4-__, 5-__\n```/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }));
}

for(const [name,engine] of Object.entries({chromium,webkit})) {
  test(`${name}: a paper is answered by tapping option blocks and written to its answer area`,()=>withSite(engine,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
    page.on('dialog',dialog=>dialog.accept());
    await page.getByRole('navigation',{name:'学习导航'}).getByRole('link',{name:'做题'}).click();
    await page.getByRole('link',{name:/测试试卷/}).click();
    const lists=page.locator('.option-list');
    await lists.nth(0).locator('.option-block').nth(0).click();
    assert.equal(await lists.nth(0).locator('[aria-pressed=true]').count(),1);
    for(const index of [1,3,0,2]) await lists.nth(1).locator('.option-block').nth(index).click();
    assert.equal(await page.locator('.order-line').innerText(),'语序：2 → 4 → 1 → 3');
    assert.equal(await lists.nth(1).locator('.order-badge').nth(1).innerText(),'①');
    await page.locator('.uncertain-switch').nth(1).click();
    await page.locator('#progress',{hasText:'已答 2 / 2'}).waitFor();
    await page.locator('#submit').click();
    await page.locator('#submitted').waitFor();
    assert.match(await page.locator('#grade-prompt').innerText(),/papers\/2026-10-14-test\.md/);
    const text=await readFile(join(tmp,'study/jlpt-notes/quizzes/papers/2026-10-14-test.md'),'utf8');
    assert.match(text,/```text\n1-1, \*2-2413\n```/);
    await page.goto(url+'/papers.html');
    assert.equal(await page.locator('.status-chip').innerText(),'已提交');
  }));
}
