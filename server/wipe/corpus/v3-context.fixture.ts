// SPDX-License-Identifier: AGPL-3.0-or-later
// OWNER checker: wipe-v3. OWNER corpus and injected fixtures: wipe-v3-tests.
// Commands are data only. No shell, filesystem mutation, or host probes run here.
import type { PathPort, WipeContext } from '../types.ts';
export type CorpusRow = {
 id:string; cmd:string; dialect:'sh'|'pwsh'|'cmd'; platform:'linux'|'darwin'|'win32';
 cwd:string; expect:'card'|'run'; rule?:string; tier:'gating'|'disguised'; source:string; note:string;
};
const normalize=(p:string)=>p.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
export const fixturePathPort:PathPort={
 realpath:p=>p,
 lstat:p=>({dev:1,ino:normalize(p),isSymbolicLink:()=>false}),
 stat:p=>({dev:1,ino:normalize(p),isSymbolicLink:()=>false}),
 statfs:p=>({type:normalize(p)==='/tmp'?0x01021994:0xef53}),
 isBlockDevice:p=>/^\/dev\/(?:sd[a-z]|nvme\d|r?disk\d|mmcblk\d)/.test(p)||/^\\\\\.\\PhysicalDrive\d+$/i.test(p),
};
export function corpusContext(row:Pick<CorpusRow,'platform'|'dialect'|'cwd'>,extra:WipeContext={}):WipeContext {
 const win=row.platform==='win32';
 const home=win?'C:\\Users\\u':row.platform==='darwin'?'/Users/u':'/home/u';
 const project=win?'C:\\work\\project':'/work/project';
 return {
  home,project,cwd:row.cwd,dataDir:home+'/.murage',platform:row.platform,dialect:row.dialect,
  env:{HOME:home,USERPROFILE:home,IFS:' \t\n',unset:undefined,args:undefined,p:undefined},
  registry:{contains:p=>normalize(p)===normalize(project)},pathPort:fixturePathPort,
  // MAIN RULING R1: /tmp is tmpfs and excluded from persistent mount roots.
  mountInventory:{contains:p=>['/','/volumes/fixture'].includes(normalize(p)),has:p=>['/','/volumes/fixture'].includes(normalize(p))},
  ...extra,
 };
}
export const linuxContext=(extra:WipeContext={})=>corpusContext({platform:'linux',dialect:'sh',cwd:'/work/project/pkg'},extra);
// secret-scan: fixture (generic fixture home names only; no host data)
