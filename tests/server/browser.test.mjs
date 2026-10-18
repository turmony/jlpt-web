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

test('a home-screen launch at grammar memory opens the review plan first',()=>withSite(webkit,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url)=>{
  const context=page.context();
  const tab=await context.newPage();
  await tab.goto(url+'/grammar/');await tab.locator('#start-reading:not([disabled])').waitFor();
  assert.equal(tab.url(),url+'/grammar/');
  await tab.close();
  await context.addInitScript(()=>Object.defineProperty(Navigator.prototype,'standalone',{configurable:true,get:()=>true}));
  const app=await context.newPage();
  await app.goto(url+'/grammar/');await app.waitForURL(url+'/review/');
  await app.getByRole('navigation',{name:'学习导航'}).getByRole('link',{name:'语法记忆'}).click();
  await app.waitForURL(url+'/grammar/');await app.locator('#start-reading:not([disabled])').waitFor();
  assert.equal(app.url(),url+'/grammar/');
}));

test('stage progress shows the current stage, the next milestone and the plan directory',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const finish=async(unit,minute)=>{
    const folder=join(tmp,'study/jlpt-notes/groups/submissions/r1');
    await mkdir(folder,{recursive:true});
    await writeFile(join(folder,`${unit}.json`),JSON.stringify({schema_version:1,unit_id:unit,round:1,paper:`2026-10-17-${unit.toLowerCase()}`,
      recall:{marks:[{card:'N5-G-0013',item:0,recalled:true},{card:'N5-G-0032',item:1,recalled:true}],locked_at:'2026-10-17T20:00:00+08:00'},sentence:{card:'N5-G-0013',text:'文。'},note:'',submitted_at:`2026-10-17T20:${minute}:00+08:00`}));
  };
  const stage=title=>page.locator('.stage',{has:page.locator('summary',{hasText:title})});
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  assert.equal(await page.locator('#progress-bar .stage-segment').count(),1);
  assert.equal(await page.locator('#progress-bar .stage-segment .stage-marker').count(),1);
  assert.equal(await page.locator('#next-milestone').innerText(),'下一个节点：学完基础体系表（还差 2 个单元）');
  assert.equal(await page.locator('#stage-legend').innerText(),'基础体系表 0/2');
  assert.equal(await page.locator('#stage-legend [data-status=current]').count(),1);
  await page.locator('#directory > summary').click();
  assert.equal(await stage('基础体系表').evaluate(details=>details.open),true);
  assert.match(await stage('基础体系表').locator('summary').innerText(),/基础体系表[\s\S]*0\/2[\s\S]*当前阶段/);
  assert.equal(await stage('ものごとの様子').evaluate(details=>details.open),false);
  assert.match(await stage('ものごとの様子').locator('summary').innerText(),/待整理（不计入总数）/);
  assert.match(await page.locator('.directory-list li.is-current').innerText(),/B-01-1/);

  await finish('B-01-1','10');await page.reload();
  await page.locator('#progress-summary',{hasText:'已学 1 / 2'}).waitFor();
  assert.equal(await page.locator('#progress-bar .stage-fill').evaluate(fill=>fill.style.width),'50%');
  assert.equal(await page.locator('#next-milestone').innerText(),'下一个节点：学完基础体系表（还差 1 个单元）');
  assert.match(await page.locator('.directory-list li.is-current').textContent(),/B-01-2/);
  // A learned unit opens in place of the overview (not below the open directory) and the back button restores it.
  await page.locator('#directory > summary').click();
  await page.locator('.directory-list li',{hasText:'B-01-1'}).getByRole('button',{name:'查看'}).click();
  await page.locator('#unit-title',{hasText:'B-01-1'}).waitFor();
  assert.equal(await page.locator('#plan-progress').isHidden(),true);
  assert.equal(await page.locator('#unit-view h2',{hasText:'已交卷'}).count(),1);
  assert.equal(await page.locator('#unit-view h2',{hasText:'试题回顾'}).count(),1);
  assert.equal(await page.locator('#unit-view .review-tag.correct').count(),5);
  assert.equal(await page.locator('#unit-view .review-verdict',{hasText:'未作答'}).count(),5);
  await page.locator('#unit-view .review-explain > summary').first().click();
  assert.match(await page.locator('#unit-view .review-explain').first().innerText(),/解析1/);
  await page.getByRole('button',{name:'← 今日安排'}).click();
  assert.equal(await page.locator('#plan-progress').isVisible(),true);

  await finish('B-01-2','20');await page.reload();
  await page.locator('#progress-summary',{hasText:'已学 2 / 2'}).waitFor();
  assert.equal(await page.locator('#progress-bar .stage-marker').count(),0);
  assert.equal(await page.locator('#next-milestone').innerText(),'已提交的阶段已全部学完');
  assert.equal(await page.locator('#stage-legend').innerText(),'✓ 基础体系表 2/2');
  await page.locator('#directory > summary').click();
  assert.match(await stage('基础体系表').locator('summary').innerText(),/2\/2[\s\S]*已完成/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));

test('the directory shows finished, due and next reviews next to the unit that closes the cycle',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url)=>{
  // The fixture plan has two units, so the review nodes are injected into the plan response.
  const reviews={'B-01-1':{id:'review-01',status:'done'},'B-01-2':{id:'review-02',status:'next',remaining:3}};
  await page.route('**/api/review/today',async route=>{
    const response=await route.fetch();const body=await response.json();
    for(const section of body.directory)for(const child of section.children)for(const unit of child.units)if(reviews[unit.id])unit.review=reviews[unit.id];
    await route.fulfill({response,json:body});
  });
  await page.reload();
  await page.locator('#directory > summary').click();
  const nodes=page.locator('.directory-list li.review-node');
  assert.equal(await nodes.count(),2);
  assert.match(await nodes.nth(0).innerText(),/复习 review-01[\s\S]*已完成/);
  assert.match(await nodes.nth(1).innerText(),/下次复习 review-02[\s\S]*还差 3 个学习日/);
  assert.match(await page.locator('.directory-list li').nth(1).innerText(),/review-01/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));

test('damaged study data shows the server error instead of a blank page',()=>withSite(chromium,{},async(page,url,tmp)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  const folder=join(tmp,'study/jlpt-notes/groups/submissions/r1');
  await mkdir(folder,{recursive:true});await writeFile(join(folder,'B-01-1.json'),'{');
  await page.reload();
  await page.locator('#notice',{hasText:'groups/submissions/r1/B-01-1.json'}).waitFor();
}));

test('a stale recall draft is trimmed to the current rows and the miss button is a full touch target',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.evaluate(()=>localStorage.setItem('review:B-01-1:recall',JSON.stringify({revealed:[0,5],missed:[5,1,1]})));
  await page.getByRole('button',{name:'开始'}).click();
  await page.locator('#recall-list').waitFor();
  const miss=page.locator('#recall-list .recall-row').nth(0).getByRole('button',{name:'没想到'});
  assert.ok((await miss.boundingBox()).height>=44);
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page').waitFor();
  const sub=JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/submissions/r1/B-01-1.json'),'utf8'));
  assert.deepEqual(sub.recall.marks.map(mark=>mark.recalled),[true,false]);
  assert.equal(await page.evaluate(()=>localStorage.getItem('review:B-01-1:recall')),null);
}));

for(const [name,engine] of Object.entries({chromium,webkit})) {
  test(`${name}: a unit is learned end to end on a phone`,()=>withSite(engine,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
    await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
    await page.getByRole('button',{name:'开始'}).click();
    await page.locator('#recall-list').waitFor();
    assert.equal(await page.locator('#recall-list .recall-row').count(),2);
    assert.equal(await page.locator('#unit-page').count(),0);
    assert.doesNotMatch(await page.locator('#recall-list').innerText(),/时间点|动作的方向/);
    assert.deepEqual(await page.locator('#recall-list .recall-form').allInnerTexts(),['に','へ']);
    assert.equal(await page.locator('#recall-list .recall-group').nth(1).locator('.recall-row').count(),1);
    const row=page.locator('#recall-list .recall-row').nth(1);
    await row.getByRole('button',{name:'点击显示'}).click();
    assert.equal(await row.locator('.recall-text').innerText(),'动作的方向');
    await row.getByRole('button',{name:'没想到'}).click();
    assert.equal(await row.getByRole('button',{name:'没想到'}).getAttribute('aria-pressed'),'true');
    await page.reload();
    await page.getByRole('button',{name:'开始'}).click();
    await page.locator('#recall-list').waitFor();
    const again=page.locator('#recall-list .recall-row').nth(1);
    await again.getByText('动作的方向').waitFor();
    assert.equal(await again.getByRole('button',{name:'没想到'}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#recall-list .recall-row').nth(0).getByRole('button',{name:'点击显示'}).count(),1);
    await page.getByRole('button',{name:'进入对比页'}).click();
    await page.locator('#unit-page img').first().waitFor();
    assert.equal(await page.locator('#recall-list .recall-row.missed').count(),1);
    assert.equal(await page.locator('#recall-list button').count(),0);
    assert.equal(await page.locator('#unit-page img').first().evaluate(image=>image.complete&&image.naturalWidth>0),true);
    assert.equal(await page.locator('.cards-title').count(),0);
    assert.equal(await page.locator('#unit-page details.member-card').count(),2);
    assert.equal(await page.locator('#card-N5-G-0013').evaluate(details=>!details.open
      && details.previousElementSibling.querySelector('img')?.alt==='时点に接续图'
      && details.nextElementSibling.tagName==='H3'),true);
    await page.locator('#card-N5-G-0013 summary').click();
    await page.locator('#card-N5-G-0013',{hasText:'时间词＋に，表示动作发生的时间点。'}).waitFor();
    await page.locator('#unit-page a[href="#card-N5-G-0032"]').click();
    assert.equal(await page.locator('#card-N5-G-0032').evaluate(details=>details.open),true);
    await page.locator('.option-list').first().locator('.option-block').nth(1).click();
    await page.locator('#sentence').fill('三時に会いましょう。');
    page.on('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'交卷'}).click();
    await page.locator('#status',{hasText:'已交卷，待判分'}).waitFor();
    assert.equal(await page.locator('#status').innerText(),'今日安排\n\n下一项（B-01-2 で・を）尚未准备\n\n已交卷，待判分：B-01-1');
    await page.locator('#progress-summary',{hasText:'已学 1 / 2'}).waitFor();
    const sub=JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/submissions/r1/B-01-1.json'),'utf8'));
    assert.deepEqual(sub.recall.marks.map(mark=>mark.recalled),[true,false]);
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
