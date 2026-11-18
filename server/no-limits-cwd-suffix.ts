// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { SENSITIVE_PATHS } from '../shared/sensitive-paths.ts';
import type { OwnerNlDecision } from './no-limits-authority.ts';

export interface ProtectedCwdSuffix extends OwnerNlDecision {
 readonly source:'unknown-cwd-protected-suffix';
 readonly resolution:'unknown';
 readonly matchedSuffix:string;
 readonly possibleProtectedName:string;
}
// Concrete system names supply suffix metadata; a broad /etc/** protection
// must never turn every ordinary relative basename into a protected suffix.
const systemNames=['/etc/hosts','/etc/passwd','/etc/shadow','/etc/group','/etc/gshadow','/etc/sudoers'];
const projections = [
 ...systemNames.map(name=>({ruleId:'protected-system-name',name,suffix:name.slice(name.lastIndexOf('/')+1),tree:false,caseInsensitive:false})),
 ...SENSITIVE_PATHS.filter(row=>row.id!=='murage-engine-hooks').flatMap(row=>[...row.read,...(row.cwdSuffixes??[])].map(name=>{
  const tree=name.endsWith('/**');
  const suffix=name.replace(/^(?:~\/|\*\*\/|\/etc\/)/,'').replace(/\/\*\*$/,'');
  return {ruleId:row.id,name,suffix,tree,caseInsensitive:row.re.ignoreCase};
 })),
];
const escape=(value:string)=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','[^/]*');
/** Unknown cwd has no invented physical destination. Match whole components
 * against the policy's named leaves/subtrees, retaining a known suffix after
 * an unknown prefix. Shared by recovery and the owner filesystem collector. */
export function protectedCwdSuffix(raw:string,dialect:'posix'|'pwsh'='posix'):ProtectedCwdSuffix|undefined {
 const value=(dialect==='pwsh'?raw.replaceAll('\\','/'):raw).replace(/^(?:\.\/)+/,'');
 if(value.startsWith('/')||value.startsWith('~')||/^[a-z]:/i.test(value))return;
 for(const row of projections){
  const flags=dialect==='pwsh'||row.caseInsensitive?'i':'';
  const match=new RegExp('(?:^|/)('+escape(row.suffix)+')'+(row.tree?'(?:/.*)?$':'$'),flags).exec(value);
  if(match)return {kind:'deny',class:row.ruleId==='protected-system-name'?'system':'gate',ruleId:row.ruleId,span:raw,source:'unknown-cwd-protected-suffix',resolution:'unknown',matchedSuffix:match[1]!,possibleProtectedName:row.name};
 }
 return undefined;
}
