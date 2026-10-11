#!/usr/bin/env node
// AionUi's connectCodex calls a bundled Bun launcher. This server uses the
// already-installed pinned ACP package, with the same launcher argument contract.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);
if (args[0]!=='x' || args[1]!=='--bun' || !args[2]?.startsWith('@zed-industries/codex-acp')) throw new Error('Unsupported ACP launcher request');
const entry=fileURLToPath(new URL('./dist/codex-acp.mjs',import.meta.url));
// The maintained adapter reads CODEX_CONFIG, rather than CLI -c arguments.
const config={...JSON.parse(process.env.CODEX_CONFIG || '{}'),approval_policy:'never',sandbox_mode:'workspace-write',sandbox_workspace_write:{network_access:true}};
const child=spawn(process.execPath,[entry,...args.slice(3)],{stdio:'inherit',env:{...process.env,CODEX_PATH:process.env.CODEX_PATH || 'codex',CODEX_CONFIG:JSON.stringify(config),INITIAL_AGENT_MODE:'workspace-write'}});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.once('exit',(code)=>process.exit(code ?? 1));
