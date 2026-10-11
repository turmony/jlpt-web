// Compatibility patch for the pinned maintained ACP bridge. Its mode presets
// override CODEX_CONFIG on turn/start; enforce the existing application's
// workspace-write/network-enabled/never-approve policy in the actual preset.
import {createHash} from 'node:crypto';
export const bridgeSourceSha256='6b1bb4e7e9caaf4aeca1042ae4aec2dc2433b0b0e4b1614b38a4d41699902aaa';
export function applyBridgePolicy(source) {
  if(createHash('sha256').update(source).digest('hex')!==bridgeSourceSha256) throw new Error('ACP bridge source changed: review the policy patch before upgrading');
  const start=source.indexOf('  static WorkspaceWrite = new _AgentMode(');
  const end=source.indexOf('  static Agent = new _AgentMode(',start);
  const original=source.slice(start,end);
  if(start<0 || end<0 || !original.includes('"on-request"') || !original.includes('networkAccess: false')) throw new Error('Missing ACP workspace policy preset');
  const patched=original.replace('"on-request"','"never"').replace('networkAccess: false','networkAccess: true');
  return source.slice(0,start)+patched+source.slice(end);
}
