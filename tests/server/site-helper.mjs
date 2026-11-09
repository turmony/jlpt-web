// Starts tests/server/browser_fixture.py in a temp state directory and tells the tests where it listens.
// The fixture prints one line: "<本站地址> <样例站地址>" (the JLPT site, then the sample news site on another port).
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';

export async function startFixture(env={}) {
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-site-'));
  const server=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});
  const stop=async()=>{server.kill();await rm(tmp,{recursive:true,force:true});};
  try {
    const line=await new Promise((resolve,reject)=>{server.stdout.once('data',data=>resolve(data.toString().trim()));server.stderr.once('data',data=>reject(new Error(data.toString())));});
    const [url,site]=line.split(' ');
    return {url,site,tmp,stop};
  } catch (error) {await stop();throw error;}
}

export async function withSite(engine,options,run,env={}) {
  const fixture=await startFixture(env);
  const {url,tmp}=fixture;
  let browser;
  try {
    browser=await engine.launch();
    const page=await (await browser.newContext(options)).newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url+'/login.html');
    await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();
    await page.waitForURL(url+'/review/');
    await run(page,url,tmp);
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await fixture.stop();}
}

// Writes a NEWS_HUB_SCRIPT file next to (not inside) the fixture's state directory.
export async function hubScript(spec) {
  const dir=await mkdtemp(join(tmpdir(),'jlpt-hub-'));
  const file=join(dir,'hub.json');
  await writeFile(file,JSON.stringify(spec));
  return {file,remove:()=>rm(dir,{recursive:true,force:true})};
}
