/** Server platform bindings for unmodified AionUi ACP connectors. */
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const getPlatformServices = () => ({paths:{getDataDir:()=>resolve(process.env.JLPT_AGENT_DATA || homedir(),'.jlpt-acp')}});
export const getEnhancedEnv = () => ({...process.env});
export const loadFullShellEnvironment = async () => ({...process.env});
export const getWindowsShellExecutionOptions = () => ({});
export const normalizeNpxArgsForBundledBun = (args:string[]) => args;
export const resolveNpxPath = () => fileURLToPath(new URL('../launcher.mjs',import.meta.url));
export const findSuitableNodeBin = () => process.execPath;
export const readClaudeProviderEnvFromCcSwitch = () => {throw new Error('Claude provider is not configured in this Codex adapter');};
export const mainWarn = (...args:unknown[]) => console.warn(...args);
// The upstream Windows repair path requires an Electron notification bridge.
// It is deliberately unavailable on this server, and reports that fact.
export const ipcBridge = new Proxy({}, {get:()=>{throw new Error('Desktop IPC is unavailable in the server ACP adapter');}});
