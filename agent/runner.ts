/** Application protocol adapter. ACP transport/session handling is upstream code. */
import {AcpConnection} from '../vendor/aionui/src/process/agent/acp/AcpConnection';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {existsSync,realpathSync} from 'node:fs';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';

const emit = (event:unknown) => process.stdout.write(JSON.stringify(event)+'\n');
// Upstream logs must never enter the JSON event channel.
console.log = (...args:unknown[]) => console.error(...args);
const connection = new AcpConnection();
let stopped=false;
let streaming=false;
const outputId=randomUUID(), thoughtId=randomUUID();
connection.onSessionUpdate = ({update}:any) => {
  // session/load replays persisted messages. Python already owns that history.
  if (!streaming || !update) return;
  const kind=update.sessionUpdate;
  if (kind==='agent_message_chunk' || kind==='agent_thought_chunk') {
    if(update.content?.type==='text') emit({type:kind==='agent_message_chunk'?'assistant':'thinking',text:update.content.text,message_id:kind==='agent_message_chunk'?outputId:thoughtId,delta:true});
  } else if (kind==='tool_call' || kind==='tool_call_update') {
    emit({type:'tool',text:update.title || '',message_id:update.toolCallId,data:update});
  } else if (kind==='plan') emit({type:'plan',text:'',data:update,message_id:'plan'});
};
connection.onPermissionRequest = async (request:any) => {
  emit({diagnostic:'已拒绝智能体申请扩展工作区或执行权限。'});
  const rejected=request.options?.find((option:any)=>option.kind==='reject_once');
  if(!rejected) throw new Error('Permission extensions are disabled');
  return {optionId:rejected.optionId};
};
async function stop() {
  if(stopped) return;stopped=true;
  connection.cancelPrompt();
  // Allow the cancellation notification to reach the child before cleanup.
  await new Promise(resolve=>setTimeout(resolve,150));
  await connection.disconnect();
  process.exitCode=1;
}
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{stop().catch(error=>{emit({error:String(error)});process.exitCode=1;});});
function options(option:any):any[] {
  return (option?.options || []).flatMap((entry:any)=>entry.options ? entry.options : [entry]);
}
async function applySelection(model:string,effort:string) {
  let config:any[]=connection.getConfigOptions() || [];
  const mode=config.find(option=>option.category==='mode');
  if(mode) await connection.setConfigOption(mode.id,'workspace-write');
  if(model) {
    const modelOption=config.find(option=>option.category==='model' || option.id==='model');
    if(modelOption) {
      if(!options(modelOption).some(option=>option.value===model)) throw new Error('ACP 不支持所选模型：'+model);
      await connection.setConfigOption(modelOption.id,model);
    } else {
      const info:any=connection.getModels();
      if(!info?.availableModels?.some((item:any)=>item.modelId===model)) throw new Error('ACP 不支持所选模型：'+model);
      await connection.setModel(model);
    }
  }
  config=connection.getConfigOptions() || [];
  if(effort) {
    const option=config.find(option=>option.category==='thought_level' || /reasoning|effort/.test(option.id));
    if(!option || !options(option).some(item=>item.value===effort)) throw new Error('ACP 不支持所选推理强度：'+effort);
    await connection.setConfigOption(option.id,effort);
  }
}
try {
  const line=await new Promise<string>(resolve=>{const reader=readline.createInterface({input:process.stdin});reader.once('line',line=>{reader.close();resolve(line);});});
  const input=JSON.parse(line);
  if(!input.cwd || !input.prompt || !resolve(input.cwd).startsWith('/')) throw new Error('Invalid ACP turn input');
  connection.setPromptTimeout(input.timeout || 3600);
  const workspace=realpathSync(input.cwd);
  connection.onFileOperation = ({path}) => {
    let parent=resolve(path);
    while(!existsSync(parent) && dirname(parent)!==parent) parent=dirname(parent);
    const location=realpathSync(parent), offset=relative(workspace,location);
    if(offset==='..' || offset.startsWith('../') || isAbsolute(offset)) throw new Error('ACP 文件操作超出学习工作区');
  };
  if(process.env.JLPT_CODEX_ACP_COMMAND) {
    await connection.connect('custom',process.env.JLPT_CODEX_ACP_COMMAND,resolve(input.cwd),JSON.parse(process.env.JLPT_CODEX_ACP_ARGS || '[]'));
  } else await connection.connect('codex',undefined,resolve(input.cwd));
  if(stopped) throw new Error('任务已取消');
  if(input.session) await connection.loadSession(input.session,resolve(input.cwd));
  else await connection.newSession(resolve(input.cwd));
  emit({session:connection.currentSessionId,transport:'acp'});
  await applySelection(input.model || '',input.effort || '');
  streaming=true;
  const result:any=await connection.sendPrompt(input.prompt);
  if(stopped) throw new Error('任务已取消');
  emit({type:'finish',text:'',data:{stopReason:result?.stopReason}});
} catch(error:any) {
  emit({error:error.message || String(error)});process.exitCode=1;
} finally {
  await connection.disconnect();
  // AionUi's long-lived desktop connection leaves its initialization race timer
  // alive. This one-turn server adapter exits after cleanup and flushed output.
  await new Promise<void>(resolve=>process.stdout.write('',()=>resolve()));
  process.exit(process.exitCode || 0);
}
