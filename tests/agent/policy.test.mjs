import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {applyBridgePolicy} from '../../agent/bridge-policy.mjs';
test('the bridge mode actually passed to turn/start preserves the application sandbox',async()=>{
  const built=await readFile('agent/dist/codex-acp.mjs','utf8');
  // Execute the real dependency class; CODEX_CONFIG alone is overridden by it.
  const start=built.indexOf('var AgentMode = class _AgentMode {');
  const end=built.indexOf('// src/CodexAcpClient.ts',start);
  assert.ok(start>=0 && end>start);
  const mode=vm.runInNewContext(built.slice(start,end)+'\nAgentMode.getInitialAgentMode()',{process:{env:{INITIAL_AGENT_MODE:'workspace-write'}}});
  assert.equal(mode.approvalPolicy,'never');
  assert.equal(mode.sandboxPolicy.type,'workspaceWrite');
  assert.equal(mode.sandboxPolicy.networkAccess,true);
  assert.equal(mode.sandboxPolicy.writableRoots.length,0);
  assert.throws(()=>applyBridgePolicy('upgraded dependency'),/review the policy patch/);
});
