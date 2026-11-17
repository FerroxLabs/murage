// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { protectedClass } from './always-ask.ts';
import { ownerMarks } from './shell/marks.ts';
import { resolveFrom } from './shell/walk.ts';
import { classifyPath } from './no-limits-shell.ts';
import { SENSITIVE_PATHS } from '../shared/sensitive-paths.ts';
import { gateHit } from '../shared/gate-files.ts';
import type { Evidence } from './decision/types.ts';

/** Policy authority, separate from the destination/display projection. The
 * resolver can supply alias/taint/identity decisions through this same contract.
 * Consumers must preserve each decision, including its provenance, verbatim. */
export interface OwnerNlDecision {
 readonly kind:'deny';
 readonly class:string;
 readonly ruleId:string;
 readonly span:string;
 readonly source:'direct'|'alias'|'taint'|'inode'|'effective-destination'|'unknown-cwd-protected-suffix';
 readonly resolution:'protected'|'unknown';
 readonly path?:string;
 readonly taint?:Readonly<{source:string;destination:string}>;
 readonly identity?:Readonly<{dev:string|number;ino:string|number}>;
}
export interface OwnerNlAuthority {
 readonly version:1;
 readonly decisions:readonly OwnerNlDecision[];
 readonly exhausted:boolean;
}
export class InspectionOverflow extends Error {}
const hook=SENSITIVE_PATHS.find(row=>row.id==='murage-engine-hooks')!.re;

/** Called during owner inspection, before canonical/display projection. Disk
 * resolver decisions join this object at inspection, never at delivery. */
export function inspectOwnerTargets(targets:readonly {path:string;op:'read'|'write'|'delete';decision?:OwnerNlDecision}[],cwd?:string):OwnerNlAuthority {
 const decisions:OwnerNlDecision[]=[];
 ownerMarks(()=>{
  for(const target of targets){
   if(target.decision){decisions.push(target.decision);continue;}
   if(target.op==='read'||hook.test(target.path))continue;
   if(target.op==='delete'&&classifyPath(target.path))continue;
   const path=resolveFrom(cwd,target.path);
   const cls=protectedClass(path);
   const gate=gateHit([path,path+'/'])??SENSITIVE_PATHS.find(row=>row.re.test(path)||row.re.test(path+'/'))?.id;
   if(cls||gate)decisions.push({kind:'deny',class:cls??'gate',ruleId:gate??'protected-target',span:path,source:'direct',resolution:'protected',path});
  }
 });
 return {version:1,decisions,exhausted:false};
}
/** Do not classify destination strings here. Authority is independent of every
 * presentation bound and keeps resolver provenance through durable delivery. */
export function ownerNlProtectedEvidence(authority:OwnerNlAuthority|undefined):Evidence[]{
 return (authority?.decisions??[]).map(decision=>({kind:'deny',class:decision.class,ruleId:decision.ruleId,span:decision.span.slice(0,200),ownerDecision:decision}));
}
