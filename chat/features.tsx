/** Bindings for features absent from the JLPT application. They are hidden or
 * report unsupported actions; no desktop filesystem/IPC access is simulated. */
import React from 'react';
import {controller} from './controller';
export const allSupportedExts:string[]=[];
export const getFileExtension = (name:string) => name.includes('.')?name.slice(name.lastIndexOf('.')).toLowerCase():'';
const rejectFiles = (event:any) => {
  const files=event.clipboardData?.files || event.dataTransfer?.files;
  if(files?.length) {event.preventDefault();window.dispatchEvent(new CustomEvent('jlpt:notice',{detail:'当前聊天不支持上传文件，请输入文字。'}));}
};
export const useDragUpload = () => ({isFileDragging:false,dragHandlers:{onDrop:rejectFiles,onDragOver:(event:any)=>{if(event.dataTransfer?.types?.includes('Files')) event.preventDefault();}}});
export const usePasteService = () => ({onPaste:rejectFiles,onFocus:()=>{}});
export const useUploadState = () => ({isUploading:false});
export const useAutoPreviewOfficeFiles = () => {};
export const useConversationExport = () => ({isOpen:false,loading:false,handleKeyDown:()=>false,
  openExportFlow:async()=>{
    const text=controller.getMessages().filter(item=>item.type==='text').map(item=>`## ${item.position==='right'?'用户':'Codex'}\n\n${item.content.content}`).join('\n\n');
    const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='jlpt-conversation.md';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  },closeExportFlow:()=>{}});
export const HiddenUnsupportedFeature = () => null;
export default HiddenUnsupportedFeature;
