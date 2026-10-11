import React from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal,flushSync} from 'react-dom';
import {BrowserRouter} from 'react-router-dom';
import {ConfigProvider,Select} from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import '@arco-design/web-react/dist/css/arco.css';
import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import SendBox from '../vendor/aionui/src/renderer/components/chat/sendbox';
import AcpConfigSelector from '../vendor/aionui/src/renderer/components/agent/AcpConfigSelector';
import MessageList from '../vendor/aionui/src/renderer/pages/conversation/Messages/MessageList';
import {ConversationProvider} from '../vendor/aionui/src/renderer/hooks/context/ConversationContext';
import {LayoutContext} from '../vendor/aionui/src/renderer/hooks/context/LayoutContext';
import {ThemeProvider} from '../vendor/aionui/src/renderer/hooks/context/ThemeContext';
import common from '../vendor/aionui/src/renderer/services/i18n/locales/zh-CN/common.json';
import conversation from '../vendor/aionui/src/renderer/services/i18n/locales/zh-CN/conversation.json';
import messages from '../vendor/aionui/src/renderer/services/i18n/locales/zh-CN/messages.json';
import {controller,useChat} from './controller';
import {LocalPreview} from './preview';
import './chat.css';
await i18n.use(initReactI18next).init({lng:'zh-CN',resources:{'zh-CN':{translation:{common,conversation,messages}}},interpolation:{escapeValue:false}});
(window as any).jlptChat=controller;
function ChatControls() {
  const state=useChat(), settings=state.settings;
  const cli=state.clis.find(item=>item.id===settings.cli);
  const usable=state.clis.filter(item=>item.usable && item.auth==='ready');
  const labels:any={codex:'Codex',qoder:'Qoder',agy:'Antigravity'};
  const models=[...(cli?.models || [])];
  if(settings.model && !models.some(item=>item.id===settings.model)) models.push({id:settings.model,label:settings.model,efforts:[]});
  const efforts=[...(models.find(item=>item.id===settings.model)?.efforts || [])];
  if(settings.effort && !efforts.includes(settings.effort)) efforts.push(settings.effort);
  const effortNames:any={none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极高'};
  const option=(id:string,name:string,value:string,choices:any[])=>[{id,name,type:'select',currentValue:value || '__default__',options:choices}];
  const change=(key:string,value:string)=>controller.onSetting(key,value==='__default__'?'':value);
  return <div className="chat-controls">
    <div id="cli" title={state.task?'当前对话固定智能体，新建对话后可切换':'仅显示已验证真实对话的智能体'}>
      <Select aria-label="智能体" size="small" className="chat-agent-select" dropdownMenuClassName="chat-agent-options"
        value={usable.some(item=>item.id===settings.cli)?settings.cli:undefined}
        placeholder={state.task ? `${labels[settings.cli] || settings.cli}（暂不可用）` : state.clis.some(item=>item.checking)?'验证中…':'暂无可用智能体'}
        options={usable.map(item=>({value:item.id,label:labels[item.id] || item.id}))}
        disabled={!!state.task || !state.ready || !usable.length} onChange={value=>change('cli',String(value))}/>
    </div>
    <div id="model-selector" aria-label="模型"><AcpConfigSelector backend={settings.cli} initialConfigOptions={option('model','模型',settings.model,[{value:'__default__',name:'默认模型'},...models.map(item=>({value:item.id,name:item.label}))])} onOptionSelect={(_id,value)=>change('model',value)}/>
      {!models.length && <span className="chat-default-setting">默认模型</span>}
    </div>
    <div id="effort-selector" aria-label="推理强度"><AcpConfigSelector backend={settings.cli} initialConfigOptions={option('reasoning_effort','推理强度',settings.effort,[{value:'__default__',name:'默认强度'},...efforts.map(value=>({value,name:effortNames[value] || value}))])} onOptionSelect={(_id,value)=>change('effort',value)}/>
      {!efforts.length && <span className="chat-default-setting" title="选择支持推理强度的模型后可设置">默认强度</span>}
    </div>
  </div>;
}
function Chat() {
  const state=useChat(), [mobile,setMobile]=React.useState(innerWidth<=700);
  React.useEffect(()=>{if(!state.running)return;const timer=setInterval(()=>controller.tick(),1000);return()=>clearInterval(timer);},[state.running]);
  React.useEffect(()=>{const listener=()=>setMobile(innerWidth<=700);window.addEventListener('resize',listener);return()=>window.removeEventListener('resize',listener);},[]);
  return <BrowserRouter><ConfigProvider locale={zhCN}><ThemeProvider><LayoutContext.Provider value={{isMobile:mobile,siderCollapsed:mobile,setSiderCollapsed:()=>{}}}>
    <ConversationProvider value={{conversationId:state.task?.id || 'new',type:'acp'}}>
      {createPortal(<MessageList emptySlot={<div className="chat-empty"><span>JLPT · 智能体练习</span><h2>今天想练什么？</h2><p>输入后直接发送。答案和处理过程会显示在这里。</p></div>}/>,document.getElementById('chat-messages')!)}
      {createPortal(state.running && state.task?.started_at && !state.messages.some(message=>message.content.workTime?.startsWith('工作中')) ? <span className="chat-work-time">工作中 {Math.max(0,Math.floor(Date.now()/1000-state.task.started_at))} 秒</span> : null,document.getElementById('chat-timer')!)}
      {createPortal(<SendBox value={state.input} onChange={input=>{controller.setInput(input);controller.onInput();}}
        onSend={()=>controller.onSend()}
        onStop={()=>controller.onStop()} loading={state.running || state.sending} sendDisabled={!!state.task?.archived_at || !state.ready || !state.clis.some(item=>item.id===state.settings.cli && item.usable && item.auth==='ready') || ['complete','commit_failed'].includes(state.task?.status)}
        inputId="prompt" sendButtonId="execute" clearOnSend={false} enableBuiltinCommands={false} inlineReplyQuote
        defaultMultiLine lockMultiLine placeholder=""
        tools={<ChatControls/>}/>,document.getElementById('chat-input')!)}
      <LocalPreview/>
    </ConversationProvider>
  </LayoutContext.Provider></ThemeProvider></ConfigProvider></BrowserRouter>;
}
flushSync(()=>createRoot(document.getElementById('chat-react')!).render(<Chat/>));
