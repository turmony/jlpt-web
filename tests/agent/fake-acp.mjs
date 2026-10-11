import readline from 'node:readline';
import {writeFileSync, existsSync, readFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
const calls = [], settings = {};
let permissionReply;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\n');
const configOptions = () => [
  {id:'mode',name:'Mode',category:'mode',type:'select',currentValue:settings.mode || 'agent-full-access',options:[{value:'workspace-write',name:'Workspace'}]},
  {id:'model',name:'Model',category:'model',type:'select',currentValue:settings.model || 'example',options:[{value:'example',name:'Example'}]},
  {id:'reasoning_effort',name:'Reasoning',category:'thought_level',type:'select',currentValue:settings.reasoning_effort || 'low',options:[{value:'low',name:'Low'},{value:'high',name:'High'}]},
];
readline.createInterface({input:process.stdin}).on('line', async line => {
  const request = JSON.parse(line), {id, method, params} = request;
  if (!method) {if(id===900) permissionReply?.(request.result);return;}
  calls.push(method);
  const reply = result => send({id,result});
  const update = update => send({method:'session/update',params:{sessionId:'fixture-session',update}});
  if (method === 'initialize') return reply({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
  if (method === 'session/new' || method === 'session/load') {
    if (params.sessionId === 'missing') return send({id,error:{code:-32000,message:'Unknown session'}});
    if (method === 'session/load') update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'previous-turn-replay'}});
    return reply({...(method === 'session/new' ? {sessionId:'fixture-session'} : {}),configOptions:configOptions()});
  }
  if (method === 'session/set_config_option') {settings[params.configId] = params.value; return reply({configOptions:configOptions()});}
  if (method === 'session/set_model') {settings.model=params.modelId;return reply({});}
  if (method === 'session/cancel') {writeFileSync(join(process.cwd(),'cancelled'),'yes'); return;}
  if (method === 'session/prompt') {
    const text=params.prompt[0].text;
    if(text==='permissions') {
      const response=new Promise(resolve=>permissionReply=resolve);
      send({id:900,method:'session/request_permission',params:{sessionId:'fixture-session',toolCall:{toolCallId:'outside',title:'Additional sandbox permissions',rawInput:{permissions:{fileSystem:{write:['/tmp/outside-learning-workspace']}}}},options:[{optionId:'allow_permissions_turn',name:'Allow',kind:'allow_once'},{optionId:'reject_permissions',name:'Reject',kind:'reject_once'}]}});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(await response)}});
      return reply({stopReason:'end_turn'});
    }
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'你好，'}});
    if (text === 'hang') return;
    if (text === 'fail') return send({id,error:{code:-32000,message:'Fixture failed'}});
    if (text === 'crash') return process.exit(7);
    update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'检查范围'}});
    update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'读取资料',kind:'read',status:'in_progress'});
    update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',content:[{type:'content',content:{type:'text',text:'已读取'}}]});
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'**世界**'}});
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({calls,settings,prompt:text})}});
    const contextPath=join(process.cwd(),'jlpt-notes/quizzes/web/current-turn.json');
    if (existsSync(contextPath)) {
      const context=JSON.parse(readFileSync(contextPath));
      const folder=join(process.cwd(),'jlpt-notes/quizzes/web',context.task_id); mkdirSync(folder,{recursive:true});
      writeFileSync(join(folder,`turn-${context.turn}.json`),JSON.stringify({task_id:context.task_id,turn:context.turn,operation:'clarify',message:'请补充范围'}));
    }
    return reply({stopReason:'end_turn'});
  }
  send({id,error:{code:-32601,message:'Unsupported fixture method '+method}});
});
