// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Last-seam checks authenticate through the authoritative request reader. The
// caller supplies an exact issued operation, never an owner/answeredBy flag.
import type { OwnerOperation as InspectedOperation } from '../no-limits-inspection.ts';
import type { ProtectedDecision } from '../no-limits-fs.ts';
import { issuedOperationHash } from '../no-limits-operation.ts';
import { wipeBreaker, nativeEffectsWipe, nativeWipeBreaker } from '../wipe-breaker.ts';
import { degradedWipeContext, wipeContextFor, wipeEnvironment } from '../wipe/context.ts';
import type { ExecEnv } from '../../shared/mount-identity.ts';
import type { AlwaysAskHit } from '../always-ask.ts';
import { freeze, canonical } from './bounds.ts';
import type { ApprovalRef } from './types.ts';
import { wipeFingerprint } from './wipe-fingerprint.ts';

/** Terminal label shared by refreshed-card writers and answer readers. */
export const RELEASE_SUPERSEDED = 'Permission changed before release';

export interface ReleaseWipeIdentity { readonly threadId:string; readonly botId?:string; readonly execEnv?:ExecEnv }
export interface ReleaseIdentity { readonly requestKey: string; readonly threadId: string; readonly generation: string }
export interface ReleaseInspection {
  readonly decisions: readonly ProtectedDecision[];
  /** Fresh catastrophe findings, independent of protected-path diagnostics. */
  readonly wipes?: readonly ReleaseWipe[];
  /** Full trigger/anchor resolutions, not just the IDs on a selected write. */
  readonly taintEvidence?: readonly unknown[];
}
export interface ReleaseWipe { readonly operandId?: string; readonly path?: string; readonly hit: AlwaysAskHit | Readonly<{rule:'wipe-cleared';what:''}>; readonly resolvedTargets: readonly string[]; readonly fingerprint?: string }
export interface ApprovedReleaseEvidence { readonly operationHash: string; readonly inspection: ReleaseInspection }
export type ReleaseBinding = Readonly<{ posture: 'legacy' }> | Readonly<{
  posture: 'owner-no-limits'; operationHash: string;
  /** Authenticated checked/handed record retained with this request. */
  execEnv?: ExecEnv; botId?: string;
  /** Runs the same owner inspector on fresh disk/context, including the named
   * inode registry. Do not close over an earlier inspection result. */
  inspect(operation: InspectedOperation): ReleaseInspection;
  /** Validates the issued reference against its authoritative durable row. */
  approved(reference: ApprovalRef): ApprovedReleaseEvidence | undefined;
}>;
export interface ReleaseRequest extends ReleaseIdentity {
  readonly exactOperation: InspectedOperation; readonly operationHash: string;
  readonly approvedEvidence?: ApprovalRef;
  readonly releaseKind: 'hook' | 'native' | 'cache' | 'exec' | 'service' | 'queue';
}
export type ReleaseResult = Readonly<{ kind: 'release' }>
  | Readonly<{ kind: 'hold'; inspection: ReleaseInspection }>
  | Readonly<{ kind: 'refuse'; reason: 'unregistered-release' | 'operation-integrity' | 'operation-changed' | 'unverified-approval' | 'inspection-integrity' }>;
let reader: ((identity: ReleaseIdentity) => ReleaseBinding | undefined) | undefined;

/** Internal S1 installation seam. The implementation resolves its own Entries
 * and reauthenticates live provenance; no model/tool/HTTP input installs it. */
export function installReleaseContextReader(next: (identity: ReleaseIdentity) => ReleaseBinding | undefined): () => void {
  reader=next;return()=>{if(reader===next)reader=undefined;};
}
const RELEASE=Object.freeze({kind:'release' as const});
const refuse=(reason:Extract<ReleaseResult,{kind:'refuse'}>['reason']):ReleaseResult=>Object.freeze({kind:'refuse',reason});

function evidenceValue(value: unknown, field = ''): unknown {
  if(Array.isArray(value)){
    const values=value.map(item=>evidenceValue(item));
    return ['taintOperationIds','dependencyOperationIds','taintCauses'].includes(field)?values.sort((a,b)=>canonical(a).localeCompare(canonical(b))):values;
  }
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='nlink').map(([key,item])=>[key,evidenceValue(item,key)]));
  return value;
}
function covered(fresh: readonly unknown[], approved: readonly unknown[]): boolean {
  const accepted=new Set(approved.map(item=>canonical(evidenceValue(item))));
  return fresh.every(item=>accepted.has(canonical(evidenceValue(item))));
}
/** Coverage binds every reason, operand, actual path/source, inode, placement,
 * cwd and taint trigger/anchor. More resolved evidence is never a wildcard. */
export function approvedEvidenceCovers(fresh: ReleaseInspection, approved: ReleaseInspection): boolean {
  return wipeEvidenceCovers(fresh.wipes??[],approved.wipes??[])&&covered(fresh.decisions,approved.decisions)&&(!fresh.decisions.some(decision=>decision.reason==='alias-taint')||!!fresh.taintEvidence?.length&&covered(fresh.taintEvidence,approved.taintEvidence??[]));
}
/** Only byte-identical, complete fingerprints authorize an existing decision.
 * Legacy target lists are diagnostics and never approval coverage. */
function wipeEvidenceCovers(fresh: readonly ReleaseWipe[], approved: readonly ReleaseWipe[]): boolean {
  if([...fresh,...approved].some(wipe=>!wipe.fingerprint))return false;
  return fresh.length===approved.length&&fresh.every((wipe,index)=>wipe.hit.rule===approved[index]!.hit.rule&&wipe.fingerprint===approved[index]!.fingerprint);
}
/** Reuse the product wipe reader on the exact executable/native effects. This
 * runs at release, so a late disk change cannot reuse a clean earlier scan. */
export function inspectReleaseWipes(operation: InspectedOperation, retainDecision = false, identity?:ReleaseWipeIdentity): readonly ReleaseWipe[] {
  let shared;try{shared=wipeContextFor(identity?.threadId,identity?.botId,{cwd:operation.cwd});}catch{shared=degradedWipeContext({cwd:operation.cwd},identity?.botId);}
  const engine=identity?.execEnv;
  const env=engine&&!engine.unread?wipeEnvironment(shared.env,engine.env,engine.absent):shared.env;
  const context={...shared,env,cwdOpaque:operation.cwdInvalid,...(operation.cwd?{cwd:operation.cwd}:{})};
  const hit=operation.kind==='native'?(operation.effects.length?nativeEffectsWipe(operation.effects,context):nativeWipeBreaker(operation.rawTool??'',operation.rawInput,context))
   :wipeBreaker(operation.text,{...context,...(operation.kind==='code'?{lang:operation.lang}:{dialect:operation.dialect})});
  return hit?[{hit,...wipeFingerprint(operation,hit.rule,context)}]:retainDecision?[{hit:{rule:'wipe-cleared',what:''},...wipeFingerprint(operation,'wipe-cleared',context)}]:[];
}
/** Protected inspection is diagnostic at authenticated owner No limits. Its
 * output and failures never decide release; the wipe scan always runs first. */
export function inspectReleaseOperation(operation: InspectedOperation, inspect: (operation: InspectedOperation)=>ReleaseInspection, identity?:ReleaseWipeIdentity): ReleaseInspection {
  const wipes=inspectReleaseWipes(operation,false,identity);
  let diagnostics:ReleaseInspection={decisions:[]};
  try{
    const result=inspect(operation);
    if(!Array.isArray(result.decisions)||result.decisions.some(decision=>decision.reason==='alias-taint')&&!result.taintEvidence?.length)throw new Error('invalid-protected-diagnostics');
    diagnostics=freeze({...result,wipes});
  }catch{
    // Do not log payloads, paths or arbitrary exception text.
    console.warn('[no-limits] protected-path release diagnostics failed; wipe scan remains authoritative');
  }
  return freeze({...diagnostics,wipes});
}
export function releaseGuard(request: ReleaseRequest): ReleaseResult {
  let binding:ReleaseBinding|undefined;
  try{binding=reader?.({requestKey:request.requestKey,threadId:request.threadId,generation:request.generation});}
  catch{return refuse('unregistered-release');}
  if(!binding)return refuse('unregistered-release');
  // Full access returns before touching the operation, its hash, approval or
  // filesystem. Preserve its existing driver shortcut/automatic reply bytes.
  if(binding.posture==='legacy')return RELEASE;
  const issued=issuedOperationHash(request.exactOperation);
  if(!issued||issued!==request.operationHash)return refuse('operation-integrity');
  if(binding.operationHash!==request.operationHash)return refuse('operation-changed');
  let fresh:ReleaseInspection;
  try{
    fresh=inspectReleaseOperation(request.exactOperation,binding.inspect,{threadId:request.threadId,botId:binding.botId,execEnv:binding.execEnv});
  }
  catch{return freeze({kind:'hold',inspection:{decisions:[]}});}
  let approved:ApprovedReleaseEvidence|undefined;
  if(request.approvedEvidence){
    try{approved=binding.approved(request.approvedEvidence);}catch{return refuse('unverified-approval');}
    if(!approved)return refuse('unverified-approval');
    if(approved.operationHash!==request.operationHash)return refuse('operation-changed');
  }
  // A formerly catastrophic decision cannot silently reuse its approval when
  // a retarget removes the catastrophe classification. Bind the new class too.
  if(approved?.inspection.wipes?.length&&!fresh.wipes?.length){
    try{fresh=freeze({...fresh,wipes:inspectReleaseWipes(request.exactOperation,true,{threadId:request.threadId,botId:binding.botId,execEnv:binding.execEnv})});}
    catch{return freeze({kind:'hold',inspection:{decisions:[]}});}
  }
  // Authenticated No limits has one permission stop: a fresh catastrophe.
  // Protected-only changes remain diagnostics, never an approval requirement.
  try{if(!fresh.wipes?.length||approved&&wipeEvidenceCovers(fresh.wipes,approved.inspection.wipes??[]))return RELEASE;}
  catch{return refuse('inspection-integrity');}
  return freeze({kind:'hold',inspection:fresh});
}
