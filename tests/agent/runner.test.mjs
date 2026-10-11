import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
const runner=resolve('agent/dist/runner.mjs'), fixture=resolve('tests/agent/fake-acp.mjs');
async function run(input, {cancel=false}={}) {
  const cwd=await mkdtemp(join(tmpdir(),'jlpt-acp-'));
  try {
    const child=spawn(process.execPath,[runner],{env:{...process.env,JLPT_CODEX_ACP_COMMAND:process.execPath,JLPT_CODEX_ACP_ARGS:JSON.stringify([fixture])},stdio:['pipe','pipe','pipe']});
    let output='',diagnostics='';
    child.stdout.on('data',data=>{output+=data;if(cancel && output.includes('你好')) child.kill('SIGTERM');});
    child.stderr.on('data',data=>diagnostics+=data);
    child.stdin.end(JSON.stringify({cwd,prompt:'literal $(touch nope) `whoami`',...input})+'\n');
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('runner timeout '+diagnostics));},10000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
    const events=output.trim().split('\n').filter(Boolean).map(JSON.parse);
    return {code,events,diagnostics,cancelled:await readFile(join(cwd,'cancelled'),'utf8').catch(()=>null)};
  } finally {await rm(cwd,{recursive:true,force:true});}
}
test('upstream ACP creates session, applies selections and emits actual typed chunks',async()=>{
  const result=await run({model:'example',effort:'high'});
  assert.equal(result.code,0,result.diagnostics);
  assert.ok(result.events.some(event=>event.session==='fixture-session'));
  assert.deepEqual(result.events.filter(event=>event.type==='assistant').map(event=>event.text).slice(0,2),['你好，','**世界**']);
  const summary=JSON.parse(result.events.filter(event=>event.type==='assistant').at(-1).text);
  assert.equal(summary.settings.model,'example'); assert.equal(summary.settings.reasoning_effort,'high');
  assert.equal(summary.settings.mode,'workspace-write');
  assert.equal(summary.prompt,'literal $(touch nope) `whoami`');
  assert.ok(result.events.some(event=>event.type==='tool' && event.data.status==='completed'));
  assert.ok(result.events.some(event=>event.type==='thinking'));
});
test('restores saved session and never creates a replacement on restore failure',async()=>{
  const restored=await run({session:'fixture-session'});
  assert.equal(restored.code,0,restored.diagnostics);
  assert.ok(!restored.events.some(event=>event.text==='previous-turn-replay'));
  const summary=JSON.parse(restored.events.filter(event=>event.type==='assistant').at(-1).text);
  assert.ok(summary.calls.includes('session/load'));assert.ok(!summary.calls.includes('session/new'));
  const missing=await run({session:'missing'});assert.notEqual(missing.code,0);assert.match(missing.events.at(-1).error,/Unknown session/);
});
test('unsupported explicit model or effort fails before prompting',async()=>{
  for(const input of [{model:'unknown'},{effort:'ultra'}]) {
    const result=await run(input);assert.notEqual(result.code,0);assert.ok(result.events.some(event=>event.error));assert.ok(!result.events.some(event=>event.type==='assistant'));
  }
});
test('errors and crashes preserve received content and exit without hanging',async()=>{
  for(const prompt of ['fail','crash']) {
    const result=await run({prompt});assert.notEqual(result.code,0);assert.ok(result.events.some(event=>event.text==='你好，'));assert.ok(result.events.at(-1).error);
  }
});
test('SIGTERM uses upstream session/cancel before process cleanup',async()=>{
  const result=await run({prompt:'hang'},{cancel:true});assert.equal(result.cancelled,'yes');assert.notEqual(result.code,0);
});
test('workspace-external permission extensions are refused',async()=>{
  const result=await run({prompt:'permissions'});
  assert.equal(result.code,0,result.diagnostics);
  const response=JSON.parse(result.events.find(event=>event.type==='assistant').text);
  assert.equal(response.outcome.outcome,'selected');
  assert.match(response.outcome.optionId,/reject/);
});
