import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {withSite} from './site-helper.mjs';
const require=createRequire(new URL('../../mobile/package.json',import.meta.url));
const {chromium,webkit,devices}=require('playwright');

test('home and login open the review plan; grammar page links back',()=>withSite(chromium,{},async(page,url)=>{
  await page.goto(url+'/');await page.waitForURL(url+'/review/');
  await page.goto(url+'/login.html');await page.waitForURL(url+'/review/');
  await page.goto(url+'/grammar/');
  await page.locator('#start-reading:not([disabled])').waitFor();
  assert.equal(await page.getByRole('link',{name:'今日安排'}).getAttribute('href'),'/review/');
  assert.equal(await page.getByRole('link',{name:'做题'}).getAttribute('href'),'/papers.html');
  assert.equal(await page.getByRole('link',{name:'云开发'}).count(),0);
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

test('the review panel preselects due units, adds a range of other units and submits them together',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const beijing=offset=>new Date(Date.now()+8*3600e3+offset*864e5).toISOString().slice(0,10);
  // G-001 was reviewed yesterday (not due, but it can still be added as an extra); G-002 and G-003 are due.
  const learn=[['G-001',-3,'に・へ'],['G-002',-2,'から・まで'],['G-003',-1,'で・を']];
  const code='import sys;from datetime import date;from pathlib import Path;from tests.server.review_fixture import learn_group_unit\n'
    +learn.map(([unit,offset,title])=>`learn_group_unit(Path(sys.argv[1]),'${unit}',date.fromisoformat('${beijing(offset)}'),title='${title}')`).join('\n');
  execFileSync('python3',['-c',code,join(tmp,'study')],{cwd:new URL('../..',import.meta.url).pathname});
  await writeFile(join(tmp,'study/jlpt-notes/groups/spaced-reviews.json'),JSON.stringify({schema_version:2,done:[{unit:'G-001',date:beijing(-1),at:`${beijing(-1)}T21:00:00+08:00`}]}));
  await page.reload();
  const block=page.locator('#spaced-review');
  await page.locator('#spaced-due .spaced-unit').first().waitFor();
  assert.equal(await page.locator('#spaced-title').innerText(),'复习');
  assert.equal(await page.locator('#spaced-summary').innerText(),'今天到期 2 个单元：点掉没复习的，再确认提交');
  const units=page.locator('#spaced-due .spaced-unit');
  assert.equal(await units.count(),2);
  for (const at of [0,1]) assert.equal(await units.nth(at).getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#spaced-count').innerText(),'本次共 2 个单元');
  await units.nth(0).click();
  assert.equal(await units.nth(0).getAttribute('aria-pressed'),'false');
  assert.equal(await page.locator('#spaced-count').innerText(),'本次共 1 个单元');
  await page.locator('#spaced-add-range').click();
  assert.equal(await block.locator('.spaced-range').count(),1);
  await block.locator('.range-from').selectOption('G-003');
  await block.locator('.range-to').selectOption('G-001');
  assert.equal(await page.locator('#spaced-count').innerText(),'本次共 3 个单元');
  await page.locator('#spaced-submit').click();
  await block.getByText('今日已复习：G-001、G-002、G-003').waitFor();
  assert.equal(await page.locator('#spaced-done').innerText(),'今日已复习：G-001、G-002、G-003');
  assert.equal(await page.locator('#spaced-due .spaced-unit').count(),0);
  assert.equal(await block.locator('.spaced-range').count(),0);
  const stored=JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/spaced-reviews.json'),'utf8'));
  assert.equal(stored.schema_version,2);
  // The yesterday record of G-001 stays; the three submitted now are added.
  assert.equal(stored.done.length,4);
  assert.deepEqual(stored.done.filter(item=>item.date===beijing(0)).map(item=>item.unit).sort(),['G-001','G-002','G-003']);
  await page.reload();
  await block.getByText('今日已复习：G-001、G-002、G-003').waitFor();
  assert.equal(await page.locator('#spaced-done').innerText(),'今日已复习：G-001、G-002、G-003');
}));

test('today\'s new units follow daily_new and what was actually submitted',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const notes=join(tmp,'study/jlpt-notes/groups');
  assert.equal(await page.locator('#daily-new').isHidden(),true);
  await mkdir(notes,{recursive:true});
  await writeFile(join(notes,'plan.json'),JSON.stringify({schema_version:1,round:1,review_cycle:'off',daily_new:2}));
  await page.reload();
  const block=page.locator('#daily-new');
  await block.getByText('每天 2 个 · 今天已交卷 0 个，还差 2 个').waitFor();
  const rows=block.locator('li');
  assert.equal(await rows.count(),2);
  assert.match(await rows.nth(0).innerText(),/B-01-1[\s\S]*待学[\s\S]*开始/);
  assert.match(await rows.nth(1).innerText(),/B-01-2[\s\S]*尚未准备/);
  assert.equal(await rows.nth(1).getByRole('button').count(),0);
  await mkdir(join(notes,'submissions/r1'),{recursive:true});
  await writeFile(join(notes,'submissions/r1/B-01-1.json'),JSON.stringify({schema_version:1,unit_id:'B-01-1',round:1,paper:'2026-10-17-b-01-1',note:'',submitted_at:new Date().toISOString()}));
  await page.reload();
  await block.getByText('今天已交卷 1 个，还差 1 个').waitFor();
  assert.match(await rows.nth(0).innerText(),/B-01-1[\s\S]*今天已完成 ✓/);
}));

test('the cycle line follows the plan: shown while the 7-day review is on, hidden once it is retired',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  await page.locator('#progress-cycle',{hasText:'距下次复习还差 7 个学习日'}).waitFor();
  const plan=join(tmp,'study/jlpt-notes/groups/plan.json');
  await mkdir(join(tmp,'study/jlpt-notes/groups'),{recursive:true});
  await writeFile(plan,JSON.stringify({schema_version:1,round:1,review_cycle:'off'}));
  await page.reload();
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  assert.equal(await page.locator('#progress-cycle').isHidden(),true);
  assert.equal(await page.locator('#status').innerText().then(text=>text.includes('复习已到期')),false);
}));

test('stage progress shows the current stage, the next milestone and the plan directory',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const finish=async(unit,minute)=>{
    const folder=join(tmp,'study/jlpt-notes/groups/submissions/r1');
    await mkdir(folder,{recursive:true});
    await writeFile(join(folder,`${unit}.json`),JSON.stringify({schema_version:1,unit_id:unit,round:1,paper:`2026-10-17-${unit.toLowerCase()}`,
      sentence:{card:'N5-G-0013',text:'文。'},note:'',submitted_at:`2026-10-17T20:${minute}:00+08:00`}));
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
  assert.equal(await nodes.nth(0).getByRole('button',{name:'查看'}).count(),1);
  assert.equal(await nodes.nth(1).getByRole('button',{name:'查看'}).count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));

test('damaged study data shows the server error instead of a blank page',()=>withSite(chromium,{},async(page,url,tmp)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  const folder=join(tmp,'study/jlpt-notes/groups/submissions/r1');
  await mkdir(folder,{recursive:true});await writeFile(join(folder,'B-01-1.json'),'{');
  await page.reload();
  await page.locator('#notice',{hasText:'groups/submissions/r1/B-01-1.json'}).waitFor();
}));

test('the usage overview shows each usage straight away and records nothing about it',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#recall-list').waitFor();
  assert.deepEqual(await page.locator('#recall-list .recall-text').allInnerTexts(),['时间点','动作的方向']);
  assert.equal(await page.locator('#unit-view .step h2').first().innerText(),'一、用法总览');
  assert.doesNotMatch(await page.locator('#unit-view').innerText(),/没想到|点击显示|回忆/);
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page').waitFor();
  const sub=JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/submissions/r1/B-01-1.json'),'utf8'));
  assert.equal('recall' in sub,false);
  assert.equal(await page.locator('#recall-list .recall-mask').count(),2);
  assert.doesNotMatch(await page.locator('#unit-view').innerText(),/已锁定/);
}));

test('usages show on the first look, start as bars once the unit is entered, and slide per form or all at once',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#recall-list').waitFor();
  const all=page.locator('.recall-bar .recall-switch');
  const forms=page.locator('#recall-list .recall-switch');
  // First look: everything shown, every switch is on.
  assert.deepEqual(await page.locator('#recall-list .recall-text').allInnerTexts(),['时间点','动作的方向']);
  assert.deepEqual(await forms.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-checked'))),['true','true']);
  assert.equal(await all.getAttribute('aria-checked'),'true');
  assert.equal(await all.getAttribute('role'),'switch');
  // One form off: that form turns into bars, the other stays, "all" sits in the middle.
  await forms.first().click();
  assert.equal(await forms.first().getAttribute('aria-checked'),'false');
  assert.equal(await page.locator('#recall-list .recall-group').first().locator('.recall-text').count(),0);
  assert.equal(await page.locator('#recall-list .recall-group').first().locator('.recall-mask').count(),1);
  assert.deepEqual(await page.locator('#recall-list .recall-text').allInnerTexts(),['动作的方向']);
  assert.equal(await all.getAttribute('aria-checked'),'mixed');
  // "All" with something hidden shows everything; with everything shown hides everything.
  await all.click();
  assert.equal(await page.locator('#recall-list .recall-text').count(),2);
  assert.equal(await all.getAttribute('aria-checked'),'true');
  await all.click();
  assert.equal(await page.locator('#recall-list .recall-text').count(),0);
  assert.equal(await page.locator('#recall-list .recall-mask').count(),2);
  assert.equal(await all.getAttribute('aria-checked'),'false');
  await all.click();
  // Entered: the usages start as bars; the form names stay and no usage text is in the page.
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page').waitFor();
  assert.equal(await page.locator('#recall-list .recall-text').count(),0);
  assert.equal(await page.locator('#recall-list').innerText().then(text=>/时间点|动作的方向/.test(text)),false);
  assert.deepEqual(await page.locator('#recall-list .recall-form').allInnerTexts(),['に','へ']);
  assert.equal(await page.locator('#recall-list .recall-mask').count(),2);
  assert.equal(await all.getAttribute('aria-checked'),'false');
  assert.doesNotMatch(await page.locator('#unit-view').innerText(),/用法已隐藏/);
  // Clicking the bars reveals that form; its switch follows.
  await page.locator('#recall-list .recall-group').nth(1).locator('.recall-rows').click();
  assert.deepEqual(await page.locator('#recall-list .recall-text').allInnerTexts(),['动作的方向']);
  assert.equal(await forms.nth(1).getAttribute('aria-checked'),'true');
  assert.equal(await all.getAttribute('aria-checked'),'mixed');
  // Hiding again leaves a bar and no text.
  await forms.nth(1).click();
  assert.equal(await page.locator('#recall-list .recall-text').count(),0);
  assert.equal(await page.locator('#compare').isVisible(),true);
  const box=await forms.first().boundingBox();
  assert.ok(box.height>=44);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));

test('each form of an entered unit has a wordless can\'t-recall sticker that counts every tap, can take the last taps back and keeps the count',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const log=async()=>{try{return JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/forgets.json'),'utf8')).events;}catch{return [];}};
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#recall-list').waitFor();
  // First look: nothing learned yet, so nothing to forget.
  assert.equal(await page.locator('#recall-list .forget').count(),0);
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page').waitFor();
  const group=page.locator('#recall-list .recall-group');
  const forget=page.locator('#recall-list .forget');
  const count=index=>group.nth(index).locator('.forget-count').innerText();
  assert.equal(await forget.count(),2);
  assert.deepEqual(await forget.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))),['に 想不起来，已记 0 次','へ 想不起来，已记 0 次']);
  // No words on the sticker, only a face; zero is shown too.
  assert.doesNotMatch(await page.locator('#recall-list').innerText(),/忘/);
  assert.deepEqual([await count(0),await count(1)],['0','0']);
  const face=await forget.first().locator('.forget-face').innerText();
  await forget.first().click();
  assert.notEqual(await forget.first().locator('.forget-face').innerText(),face);
  await forget.first().click();
  await forget.first().click();
  assert.equal(await count(0),'3');
  // Each tap throws out a sticker with the count it reached.
  assert.equal(await page.locator('#recall-list .forget-burst > *').last().innerText(),'3');
  const undo=group.first().getByRole('button',{name:'撤销'});
  await undo.waitFor();
  for (let wait=0;(await log()).length<3&&wait<50;wait++) await page.waitForTimeout(100);
  assert.deepEqual((await log()).map(event=>[event.unit,event.form,event.cards]),Array(3).fill(['B-01-1','に',['N5-G-0013']]));
  await undo.click();
  assert.equal(await count(0),'2');
  for (let wait=0;(await log()).length>2&&wait<50;wait++) await page.waitForTimeout(100);
  assert.equal((await log()).length,2);
  assert.equal(await forget.first().getAttribute('aria-label'),'に 想不起来，已记 2 次');
  // The undo goes away by itself; the count is kept by the server.
  await undo.waitFor({state:'hidden',timeout:8000});
  assert.equal(await count(1),'0');
  const box=await forget.first().boundingBox();
  assert.ok(box.height>=44&&box.width>=44);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.reload();
  await page.locator('#status').getByRole('button',{name:'继续'}).click();
  await page.locator('#unit-page').waitFor();
  assert.equal(await page.locator('#recall-list .recall-group').first().locator('.forget-count').innerText(),'2');
}));

test('the comparison stacks by item on a phone, switches to per-form cards and has no sideways scroll',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#compare').waitFor();
  assert.equal(await page.locator('.compare-title').innerText(),'对比表');
  assert.doesNotMatch(await page.locator('#compare').innerText(),/情境|一句话记忆|代表例句/);
  assert.deepEqual(await page.locator('.compare-by-item .compare-block h4').allInnerTexts(),['接续','核心含义','语气与感情色彩']);
  assert.equal(await page.locator('.compare-by-item .compare-block').first().locator('.compare-line').count(),2);
  assert.equal(await page.locator('.compare-by-item .compare-block').first().locator('.compare-value').first().innerText(),'时间词＋に');
  assert.equal(await page.locator('.compare-by-form').isVisible(),false);
  assert.equal(await page.locator('.compare-table').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.getByRole('button',{name:'按语法看'}).click();
  assert.equal(await page.locator('.compare-by-item').isVisible(),false);
  assert.equal(await page.locator('.compare-by-form .compare-block').count(),2);
  assert.equal(await page.getByRole('button',{name:'按语法看'}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
}));

test('the comparison is a real table on a wide screen',()=>withSite(chromium,{viewport:{width:1100,height:800},locale:'zh-CN'},async(page)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#compare').waitFor();
  assert.equal(await page.locator('.compare-table').isVisible(),true);
  assert.equal(await page.locator('.compare-by-item').isVisible(),false);
  assert.equal(await page.locator('.compare-mode').first().isVisible(),false);
  assert.deepEqual(await page.locator('.compare-table thead th').allInnerTexts(),['项目','に','へ']);
  assert.equal(await page.locator('.compare-table tbody tr').count(),3);
}));

for(const [name,engine] of Object.entries({chromium,webkit})) {
  test(`${name}: a unit is learned end to end on a phone`,()=>withSite(engine,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
    await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
    await page.locator('#status').getByRole('button',{name:'开始'}).click();
    await page.locator('#recall-list').waitFor();
    assert.equal(await page.locator('#recall-list .recall-row').count(),2);
    assert.equal(await page.locator('#unit-page').count(),0);
    assert.deepEqual(await page.locator('#recall-list .recall-text').allInnerTexts(),['时间点','动作的方向']);
    assert.deepEqual(await page.locator('#recall-list .recall-form').allInnerTexts(),['に','へ']);
    assert.equal(await page.locator('#recall-list .recall-group').nth(1).locator('.recall-row').count(),1);
    await page.getByRole('button',{name:'进入对比页'}).click();
    await page.locator('#unit-page img').first().waitFor();
    assert.equal(await page.locator('#unit-page img').first().evaluate(image=>image.complete&&image.naturalWidth>0),true);
    assert.equal(await page.locator('.cards-title').count(),0);
    assert.equal(await page.locator('#unit-page details.member-card').count(),2);
    assert.equal(await page.locator('#card-N5-G-0013').evaluate(details=>!details.open
      && details.previousElementSibling.querySelector('img')?.alt==='时点に接续图'
      && details.nextElementSibling.classList.contains('compare-meaning')
      && details.nextElementSibling.nextElementSibling.tagName==='H3'),true);
    assert.match(await page.locator('#card-N5-G-0013 + .compare-meaning').innerText(),/核心含义[\s\S]*に[\s\S]*时间点/);
    await page.locator('#card-N5-G-0013 summary').click();
    await page.locator('#card-N5-G-0013',{hasText:'时间词＋に，表示动作发生的时间点。'}).waitFor();
    await page.locator('#unit-page a[href="#card-N5-G-0032"]').click();
    assert.deepEqual(await page.locator('#card-N5-G-0032 h2').allInnerTexts(),['功能一 1/2：对象','功能二 2/2：到达点']);
    assert.equal(await page.locator('#card-N5-G-0032').evaluate(details=>details.open),true);
    await page.locator('.option-list').first().locator('.option-block').nth(1).click();
    await page.locator('#sentence').fill('三時に会いましょう。');
    page.on('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'交卷'}).click();
    await page.locator('#status',{hasText:'已交卷，待判分'}).waitFor();
    assert.equal(await page.locator('#status').innerText(),'今日安排\n\n下一项（B-01-2 で・を）尚未准备\n\n已交卷，待判分：B-01-1');
    await page.locator('#progress-summary',{hasText:'已学 1 / 2'}).waitFor();
    const sub=JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/submissions/r1/B-01-1.json'),'utf8'));
    assert.equal('recall' in sub,false);
    assert.equal(sub.sentence.text,'三時に会いましょう。');
    const paper=await readFile(join(tmp,'study/jlpt-notes/quizzes/papers/2026-10-17-b-01-1.md'),'utf8');
    assert.match(paper,/```text\n1-2, 2-__, 3-__, 4-__, 5-__\n```/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }));
}

test('a form in the usage overview jumps to its connection image, and the core meaning under the image jumps back',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#recall-list').waitFor();
  // Before the comparison page exists there is nothing to jump to.
  assert.equal(await page.locator('#recall-list .recall-jump').count(),0);
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page img').first().waitFor();
  assert.deepEqual(await page.locator('#recall-list .recall-form').allInnerTexts(),['に','へ']);
  await page.locator('#recall-list .recall-form').nth(1).getByRole('button').click();
  await page.waitForFunction(()=>Math.abs(document.getElementById('connection-N5-G-0032').getBoundingClientRect().top-16)<2);
  assert.equal(await page.locator('#connection-N5-G-0032 + p img').getAttribute('alt'),'对象に接续图');
  // Usages stay hidden: the jump does not give the recall away.
  assert.equal(await page.locator('#recall-list .recall-text').count(),0);
  await page.locator('#card-N5-G-0032 + .compare-meaning .compare-value').click();
  await page.waitForFunction(()=>Math.abs(document.querySelectorAll('#recall-list .recall-group')[1].getBoundingClientRect().top-16)<2);
  await page.locator('#card-N5-G-0013 + .compare-meaning').getByRole('button',{name:/核心含义/}).press('Enter');
  await page.waitForFunction(()=>Math.abs(document.querySelectorAll('#recall-list .recall-group')[0].getBoundingClientRect().top-16)<2);
  assert.equal(await page.locator('#card-N5-G-0013').evaluate(details=>details.open),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));

test('a unit\'s overview note heads the usage overview, before and after entering',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const file=join(tmp,'study/jlpt-notes/groups/units/B-01-1.json');
  await writeFile(file,JSON.stringify({...JSON.parse(await readFile(file,'utf8')),overview_note:'两组的差异在后项。'}));
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  const note=page.locator('#unit-view .step').first().locator('h2 + .overview-note');
  assert.equal(await note.innerText(),'两组的差异在后项。');
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page img').first().waitFor();
  assert.equal(await note.innerText(),'两组的差异在后项。');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));

test('a unit with two titled comparison tables shows each under its title, with tints running on across them',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const file=join(tmp,'study/jlpt-notes/groups/units/B-01-1.json');
  const material=JSON.parse(await readFile(file,'utf8'));
  // Each table needs two rows; the rows of cards outside the unit only fill them up.
  const [at,to]=material.compare.forms;
  const filler=(card,form)=>({...at,card,form});
  material.compare=[{title:'时间',forms:[at,filler('N5-G-0040','まで')]},{title:'方向',forms:[to,filler('N5-G-0041','から')]}];
  await writeFile(file,JSON.stringify(material));
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#compare').waitFor();
  assert.equal(await page.locator('#compare .compare-title').count(),1);
  assert.deepEqual(await page.locator('#compare .compare-subtitle').allInnerTexts(),['时间','方向']);
  assert.doesNotMatch(await page.locator('#compare').innerText(),/情境/);
  assert.equal(await page.getByRole('button',{name:'按语法看'}).count(),2);
  assert.deepEqual(await page.locator('.compare-by-item .compare-block:first-child .compare-chip').evaluateAll(chips=>chips.map(chip=>chip.dataset.tint)),['0','1','2','3']);
  // Switching one table leaves the other as it was.
  await page.getByRole('button',{name:'按语法看'}).nth(1).click();
  assert.deepEqual(await page.locator('.compare-by-item').evaluateAll(views=>views.map(view=>view.hidden)),[false,true]);
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page img').first().waitFor();
  assert.equal(await page.locator('#card-N5-G-0032 + .compare-meaning').getAttribute('data-tint'),'2');
  assert.equal(await page.locator('#card-N5-G-0032 + .compare-meaning .compare-value').innerText(),'方向');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));

test('without a comparison every card still gets a core meaning from its functions, and it jumps back to its form',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const file=join(tmp,'study/jlpt-notes/groups/units/B-01-1.json');
  const material=JSON.parse(await readFile(file,'utf8'));delete material.compare;
  await writeFile(file,JSON.stringify(material));
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page img').first().waitFor();
  assert.equal(await page.locator('#compare').count(),0);
  assert.equal(await page.locator('#unit-page .compare-meaning').count(),2);
  // A card with 功能 headings lists them; one without falls back to the meaning in its title.
  assert.deepEqual(await page.locator('#card-N5-G-0032 + .compare-meaning .compare-value li').allInnerTexts(),['对象','到达点']);
  assert.match(await page.locator('#card-N5-G-0032 + .compare-meaning').innerText(),/核心含义[\s\S]*へ/);
  assert.equal(await page.locator('#card-N5-G-0013 + .compare-meaning .compare-value').innerText(),'动作进行时点「に」');
  await page.locator('#card-N5-G-0032 + .compare-meaning').getByRole('button',{name:/核心含义/}).click();
  await page.waitForFunction(()=>Math.abs(document.querySelectorAll('#recall-list .recall-group')[1].getBoundingClientRect().top-16)<2);
  await page.locator('#recall-list .recall-jump').first().click();
  await page.waitForFunction(()=>Math.abs(document.getElementById('connection-N5-G-0013').getBoundingClientRect().top-16)<2);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));

test('a unit without a sentence prompt ends with a note box only and submits without a sentence',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const file=join(tmp,'study/jlpt-notes/groups/units/B-01-1.json');
  const material=JSON.parse(await readFile(file,'utf8'));delete material.sentence;
  await writeFile(file,JSON.stringify(material));
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page').waitFor();
  await page.locator('.option-list').first().locator('.option-block').nth(1).click();
  assert.equal(await page.locator('#sentence').count(),0);
  assert.equal(await page.locator('.sentence-prompt').count(),0);
  await page.getByRole('heading',{name:'四、备注'}).waitFor();
  await page.locator('#note').fill('对比页少了例句');
  page.on('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'交卷'}).click();
  await page.locator('#status',{hasText:'已交卷，待判分'}).waitFor();
  const sub=JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/submissions/r1/B-01-1.json'),'utf8'));
  assert.equal('sentence' in sub,false);
  assert.equal(sub.note,'对比页少了例句');
  assert.equal(await page.locator('#notice').isHidden(),true);
}));

test('交卷 still goes through when the review records cannot be rebuilt, and says so',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  await mkdir(join(tmp,'study/jlpt-notes/groups/review-records.json'),{recursive:true});
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page').waitFor();
  await page.locator('.option-list').first().locator('.option-block').nth(1).click();
  await page.locator('#sentence').fill('三時に会いましょう。');
  page.on('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'交卷'}).click();
  await page.locator('#status',{hasText:'已交卷，待判分'}).waitFor();
  await page.locator('#notice',{hasText:'已记录，但复习记录生成失败'}).waitFor();
  assert.match(await page.locator('#notice').innerText(),/groups\/review-records\.json/);
  const sub=JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/submissions/r1/B-01-1.json'),'utf8'));
  assert.equal(typeof sub.submitted_at,'string');
}));

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

test('opening the directory scrolls the current unit into view',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.evaluate(()=>{const filler=document.createElement('div');filler.style.height='3000px';document.querySelector('#directory').before(filler);});
  await page.locator('#directory > summary').click();
  await page.waitForFunction(()=>{const box=document.querySelector('#directory-body li.is-current')?.getBoundingClientRect();return box&&box.top>=0&&box.bottom<=innerHeight;});
}));

test('units and reviews get previous/next buttons at the top and bottom, only toward steps that are ready',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#recall-list').waitFor();
  // B-01-2 is not prepared in the fixture: no next button, and nothing before the first unit.
  assert.equal(await page.locator('#unit-view .pager').count(),2);
  assert.equal(await page.locator('#unit-view .pager-link').count(),0);
  await page.getByRole('button',{name:'← 今日安排'}).click();
  await page.route('**/api/review/today',async route=>{
    const response=await route.fetch();const body=await response.json();
    const units=body.directory.flatMap(section=>section.children.flatMap(child=>child.units));
    units[1].status='prepared';units[0].review={id:'review-01',status:'done'};
    await route.fulfill({response,json:body});
  });
  await page.reload();
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#unit-view .pager').first().waitFor();
  assert.deepEqual(await page.locator('#unit-view .pager-next').allInnerTexts(),['下一页 复习 review-01 →','下一页 复习 review-01 →']);
}));

test('the last unit of a category can page forward to the next category\'s first unit when it is the one to learn now',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page)=>{
  await page.route('**/api/review/today',async route=>{
    const response=await route.fetch();const body=await response.json();
    const [first,second]=body.directory.flatMap(section=>section.children.flatMap(child=>child.units));
    // Category A ends with a learned unit; category B starts with the unit to learn now.
    first.status='learned';second.status='current';
    const [section]=body.directory;
    const next={...section,title:'次の類',pending:false,children:[{...section.children[0],id:'C-2',title:'次',units:[second]}]};
    section.children[0].units=[first];
    body.directory.splice(1,0,next);
    body.state='learn';body.unit={...body.unit,id:second.id,title:second.title};
    await route.fulfill({response,json:body});
  });
  await page.reload();
  await page.locator('#directory > summary').click();
  await page.locator('.stage').evaluateAll(stages=>stages.forEach(stage=>{stage.open=true;}));
  await page.locator('.directory-list li',{hasText:'B-01-1'}).getByRole('button',{name:'查看'}).click();
  await page.locator('#unit-title',{hasText:'B-01-1'}).waitFor();
  assert.deepEqual(await page.locator('#unit-view .pager-next').allInnerTexts(),['下一页 B-01-2 →','下一页 B-01-2 →']);
  await page.getByRole('button',{name:'← 今日安排'}).first().click();
  await page.locator('.stage').evaluateAll(stages=>stages.forEach(stage=>{stage.open=true;}));
  assert.equal(await page.locator('.directory-list li',{hasText:'B-01-2'}).getByRole('button').count(),1);
}));

test('the review, papers and grammar pages no longer link to a news script or cloudcli page',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url)=>{
  const link=name=>page.getByRole('navigation',{name:'学习导航'}).getByRole('link',{name});
  assert.equal(await link('新闻脚本').count(),0);
  assert.equal(await link('云开发').count(),0);
  await page.goto(url+'/papers.html');
  assert.equal(await link('新闻脚本').count(),0);
  assert.equal(await link('云开发').count(),0);
  await page.goto(url+'/grammar/');await page.locator('#start-reading:not([disabled])').waitFor();
  assert.equal(await link('新闻脚本').count(),0);
  assert.equal(await link('云开发').count(),0);
}));
