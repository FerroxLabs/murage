// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Last-seam checks authenticate through the authoritative request reader. The
// caller supplies an exact issued operation, never an owner/answeredBy flag.
import type { OwnerOperation as InspectedOperation } from '../no-limits-inspection.ts';
import type { ProtectedDecision } from '../no-limits-fs.ts';
import { issuedOperationHash } from '../no-limits-operation.ts';
import { freeze, canonical } from './bounds.ts';
import type { ApprovalRef } from './types.ts';

/** Terminal label shared by refreshed-card writers and answer readers. */
export const RELEASE_SUPERSEDED = 'Permission changed before release';

export interface ReleaseIdentity { readonly requestKey: string; readonly threadId: string; readonly generation: string }
export interface ReleaseInspection {
  readonly decisions: readonly ProtectedDecision[];
  /** Full trigger/anchor resolutions, not just the IDs on a selected write. */
  readonly taintEvidence?: readonly unknown[];
}
export interface ApprovedReleaseEvidence { readonly operationHash: string; readonly inspection: ReleaseInspection }
export type ReleaseBinding = Readonly<{ posture: 'legacy' }> | Readonly<{
  posture: 'owner-no-limits'; operationHash: string;
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
  return covered(fresh.decisions,approved.decisions)&&(!fresh.decisions.some(decision=>decision.reason==='alias-taint')||covered(fresh.taintEvidence??[],approved.taintEvidence??[]));
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
    fresh=freeze(binding.inspect(request.exactOperation));
    if(!Array.isArray(fresh.decisions)||fresh.decisions.some(decision=>decision.reason==='alias-taint')&&!fresh.taintEvidence?.length)return refuse('inspection-integrity');
  }
  catch{return refuse('inspection-integrity');}
  let approved:ApprovedReleaseEvidence|undefined;
  if(request.approvedEvidence){
    try{approved=binding.approved(request.approvedEvidence);}catch{return refuse('unverified-approval');}
    if(!approved)return refuse('unverified-approval');
    if(approved.operationHash!==request.operationHash)return refuse('operation-changed');
  }
  try{if(approved?approvedEvidenceCovers(fresh,approved.inspection):fresh.decisions.length===0)return RELEASE;}
  catch{return refuse('inspection-integrity');}
  return freeze({kind:'hold',inspection:fresh});
}
