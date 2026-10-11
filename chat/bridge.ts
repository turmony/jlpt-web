/** Explicit browser bindings; unsupported desktop operations reject visibly. */
const unavailable=(path:string)=>Promise.reject(new Error('当前学习网页未接入此功能：'+path));
function endpoint(path:string):any {return new Proxy(()=>{}, {get:(_target,key)=>{
  if(key==='invoke' && path==='ipc.application.getZoomFactor') return async()=>1;
  if(key==='invoke') return ()=>unavailable(path);
  if(key==='on') return ()=>()=>{}; // no desktop IPC push source in browser
  if(key==='emit') return ()=>{throw new Error('Unavailable desktop event: '+path);};
  return endpoint(path+'.'+String(key));
}});}
export const ipcBridge=endpoint('ipc');
export const conversation=endpoint('ipc.conversation');
// Prepare/warmup is managed by the Python worker when a preview is enqueued.
ipcBridge.conversation.warmup; // accesses are lazy; callers handle rejection
export const theme={Color:{PrimaryColor:'var(--accent)',FunctionalColor:{success:'#83b99b',warn:'#d8ad75',error:'#df8585'}},mode:'dark'};
export const ConfigStorage={
  get:async (key:string)=>{try{return JSON.parse(localStorage.getItem('aionui-ui:'+key) || (key==='theme'?'"dark"':'null'));}catch{return key==='theme'?'dark':null;}},
  set:async (key:string,value:any)=>localStorage.setItem('aionui-ui:'+key,JSON.stringify(value)),
};
export const ProcessConfig=ConfigStorage;
