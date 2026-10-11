import {useSyncExternalStore} from 'react';
type Event = {id:number,type:string,text:string,time:number,data?:any};
type Settings = {cli:string,model:string,effort:string,operation:string};
type Snapshot = {task:any,input:string,running:boolean,sending:boolean,messages:any[],settings:Settings,clis:any[],ready:boolean};
let snapshot:Snapshot={task:null,input:'',running:false,sending:false,messages:[],settings:{cli:'codex',model:'',effort:'',operation:'auto'},clis:[],ready:false};
let events=new Map<number,Event>();
let pending:any=null;
const listeners=new Set<()=>void>();
function publish(value:Partial<Snapshot>) {snapshot={...snapshot,...value};listeners.forEach(listener=>listener());}
function messages() {
  const result:any[]=[], index=new Map<string,number>(), finishes=new Map<number,any>(), lastReplies=new Map<number,number>();
  let previousLegacy:Event|undefined;
  for(const event of [...events.values()].sort((a,b)=>a.id-b.id)) {
    const legacy=snapshot.task?.cli==='qoder' && event.type==='message' && !event.data;
    if(legacy && previousLegacy?.text===event.text) continue;
    previousLegacy=legacy ? event : undefined;
    const data=event.data || {}, generation=data.generation || 0;
    if(event.type==='finish') {finishes.set(generation,data);continue;}
    if(event.type==='diagnostic') continue;
    const id=`${generation}:${data.message_id || 'event-'+event.id}`;
    const base={id,msg_id:id,conversation_id:snapshot.task?.id,createdAt:event.time*1000,position:event.type==='user'?'right':'left',type:'text',content:{content:event.text}};
    if(event.type==='thinking') {base.type='thinking';base.content={content:event.text,status:snapshot.running?'thinking':'done'} as any;}
    if(event.type==='tool') {base.type='acp_tool_call';base.content={update:data.data || {}} as any;}
    if(event.type==='plan') {base.type='plan';base.content={entries:data.data?.entries || []} as any;}
    if(event.type==='error') {base.type='tips';base.content={content:event.text,type:'error'} as any;}
    const existing=index.get(id);
    if(existing!==undefined && data.delta) result[existing]={...result[existing],content:{...result[existing].content,content:result[existing].content.content+event.text}};
    else if(existing!==undefined && event.type==='tool') result[existing]={...base,content:{update:{...result[existing].content.update,...data.data}}};
    else if(existing!==undefined) result[existing]=base;
    else {index.set(id,result.length);result.push(base);}
    if(['assistant','message'].includes(event.type)) lastReplies.set(generation,index.get(id)!);
  }
  for(const [generation,position] of lastReplies) {
    const finish=finishes.get(generation);
    const active=snapshot.running && generation===snapshot.task?.generation && snapshot.task.started_at;
    const seconds=finish?.elapsed_seconds ?? (active ? (Date.now()/1000-snapshot.task.started_at) : undefined);
    if(seconds!==undefined) result[position]={...result[position],content:{...result[position].content,workTime:`${active && !finish?'工作中':'工作时间'} ${Math.max(0,Math.floor(seconds))} 秒`}};
  }
  if(pending) result.push({id:'pending-user',msg_id:'pending-user',conversation_id:snapshot.task?.id || 'new',createdAt:pending.time,position:'right',type:'text',content:{content:pending.text}});
  return result;
}
export const controller={
  getMessages:()=>snapshot.messages,
  getInput:()=>snapshot.input,getSettings:()=>snapshot.settings,
  onInput:()=>{},onSend:async()=>{},onStop:async()=>{},onSetting:(_key:string,_value:string)=>{},
  setInput(input:string) {publish({input});},
  setSettings(settings:Partial<Settings>) {publish({settings:{...snapshot.settings,...settings}});},
  setClis(clis:any[]) {publish({clis,ready:true});},
  setRunning(running:boolean) {publish({running});publish({messages:messages()});},
  beginSend(text:string) {pending={text,time:Date.now()};publish({sending:true,messages:messages()});},
  bindSend(message_id:string,generation:number) {if(pending) pending={...pending,message_id,generation};},
  endSend(failed=false) {if(failed) pending=null;publish({sending:false,messages:messages()});},
  tick() {publish({messages:messages()});},
  updateTask(task:any) {publish({task,running:['queued','running','checking','committing'].includes(task.status)});publish({messages:messages()});},
  setConversation(task:any) {events=new Map();pending=null;publish({task,messages:[],running:['queued','running','checking','committing'].includes(task?.status)});},
  addEvents(next:Event[]) {for(const event of next) {events.set(event.id,event);if(event.type==='user' && pending?.message_id===event.data?.message_id && pending?.generation===event.data?.generation) pending=null;}publish({messages:messages()});},
};
export const useChat = () => useSyncExternalStore(listener=>{listeners.add(listener);return()=>listeners.delete(listener);},()=>snapshot);
export const useMessageList = () => useChat().messages;
export const useChatKey = () => useChat().task?.id || '';
export const useUpdateMessageList = () => (messages:any) => publish({messages:typeof messages==='function'?messages(snapshot.messages):messages});
export const useAddOrUpdateMessage = () => () => {throw new Error('Message mutation must go through persisted JLPT task events');};
