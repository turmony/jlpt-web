import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const require=createRequire(new URL('../../mobile/package.json',import.meta.url));
const {webkit}=require('playwright');

// The Asahi entries of the default site table decide which elements are marked. The pages here keep the
// structure of real article pages (text replaced by placeholders); see tests/server/news_site/asahi-*.html.
const sites=JSON.parse(execFileSync('python3',['-I','-c',
  'import json,sys;sys.path.insert(0,".");from server.news_sites import DEFAULT_SITES;print(json.dumps(DEFAULT_SITES))'],
  {cwd:new URL('../..',import.meta.url).pathname,encoding:'utf8'}));
const asahi=sites.filter(site=>site.origin==='https://www.asahi.com');

const PAGES={
  'asahi-desktop-free.html':{path:'/articles/ASVC9368KVC9UTIL01KM.html',paragraphs:5},
  'asahi-desktop-paid.html':{path:'/articles/ASVC93J5HVC9UTNB00MM.html',paragraphs:3}, // the date line has a <p> too
  'asahi-mobile-free.html':{path:'/sp/articles/ASVC9368KVC9UTIL01KM.html',paragraphs:5},
  'asahi-mobile-paid.html':{path:'/sp/articles/ASVC93J5HVC9UTNB00MM.html',paragraphs:3},
};

for (const [file,{path,paragraphs}] of Object.entries(PAGES)) {
  test(`the Asahi site entry finds the headline and only the body in ${file}`,async()=>{
    const matching=asahi.filter(site=>new RegExp(site.path).test(path));
    assert.equal(matching.length,1);
    const html=await readFile(new URL(`./news_site/${file}`,import.meta.url),'utf8');
    const browser=await webkit.launch();
    try {
      const page=await browser.newPage();
      await page.setContent(html);
      const found=await page.evaluate(parts=>parts.map(selector=>{
        const el=document.querySelector(selector);
        return el&&{tag:el.tagName,inMain:!!el.closest('main#main'),paragraphs:[...el.children].filter(c=>c.tagName==='P').length,
          chars:el.textContent.trim().length,time:!!el.querySelector('time'),box:!!el.querySelector('.ArticleNoteBox,[data-paywall-area]'),
          inLogo:!!el.closest('header h1, h1 a')};
      }),matching[0].parts);
      const [head,body]=found;
      assert.ok(head&&body,JSON.stringify(found));
      assert.equal(head.tag,'H1');
      assert.equal(head.inLogo,false); // the first h1 on the page is the logo
      assert.equal(body.inMain,true);
      assert.equal(body.paragraphs,paragraphs);
      assert.ok(body.chars>150,`the body is the article text, not a date line: ${body.chars} characters`);
      assert.equal(body.time,false);
      assert.equal(body.box,false); // no subscription box or paywall block
    } finally {await browser.close();}
  });
}
