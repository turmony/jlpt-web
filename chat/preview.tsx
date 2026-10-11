import React, {useCallback,useState} from 'react';
const empty:any[]=[];
let handler:((text:string)=>void)|null=null;
export const usePreviewContext = () => ({
  domSnippets:empty,setSendBoxHandler:(fn:any)=>{handler=fn;},removeDomSnippet:()=>{},clearDomSnippets:()=>{},
});
// Diffs already included in a tool event can be previewed locally. Opening an
// arbitrary server file is deliberately not exposed by this application.
export const usePreviewLauncher = () => ({launchPreview:async (request:any)=>{
  const content=request.diffContent || request.fallbackContent;
  if(typeof content!=='string') {window.dispatchEvent(new CustomEvent('jlpt:notice',{detail:'此文件尚无可展示的内容。'}));return;}
  window.dispatchEvent(new CustomEvent('jlpt:preview',{detail:{title:request.fileName || '文件修改',content}}));
}});
export function LocalPreview() {
  const [preview,setPreview]=useState<any>(null);
  React.useEffect(()=>{const listener=(event:any)=>setPreview(event.detail);window.addEventListener('jlpt:preview',listener);return()=>window.removeEventListener('jlpt:preview',listener);},[]);
  return preview ? <div className="local-preview" role="dialog" aria-label={preview.title}><button onClick={()=>setPreview(null)}>关闭</button><h2>{preview.title}</h2><pre>{preview.content}</pre></div> : null;
}
