import type { MemoryBundle } from "../../shared/memory.ts";
import { database } from "../database.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import type { MemorySearchBridge } from "./search.ts";
import { assertMemoryBundle, buildMemoryBundle } from "./bundle.ts";
import { bindMemoryDisclosureSession, deliverMemoryDisclosure, linkMemoryDisclosureOutput, prepareMemoryDisclosure } from "./disclosures.ts";

/** Changed references replace a native context through fresh authorized replay.
 * Full text is intentionally absent from durable disclosure receipts.
 */
export function memoryContinuationChanged(bundle:MemoryBundle,threadId:string,instanceId:string,session:string):boolean {
  const rows=database().prepare("SELECT record_versions,source_versions,policy_revision,deletion_epoch,created_at FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? AND state='delivered' LIMIT 2049").all(threadId,instanceId,session);
  if(rows.length>2048)throw new Error("MEMORY_CONTINUATION_LIMIT");
  const latest=rows.reduce<(typeof rows)[number]|undefined>((previous,row)=>!previous||Number(row.created_at)>=Number(previous.created_at)?row:previous,undefined);
  return !latest || latest.policy_revision!==bundle.policyRevision || latest.deletion_epoch!==bundle.deletionEpoch
    || latest.record_versions!==JSON.stringify(bundle.recordVersions) || latest.source_versions!==JSON.stringify(bundle.sourceVersions);
}

/** One server-owned dispatch. Terminal events finalize while the turn capability is
 * still live; a later sendTurn resolution must not reuse that completed capability.
 */
export class MemoryDispatchReceipt {
  readonly bundle: MemoryBundle;
  readonly access: MemoryAccess;
  readonly instanceId: string;
  turnId?: string;
  private delivered = false;
  private observedOutput = false;
  private failure: unknown;
  constructor(bundle: MemoryBundle, access: MemoryAccess, instanceId: string) {
    this.bundle=bundle; this.access=access; this.instanceId=instanceId;
    prepareMemoryDisclosure(bundle,access,instanceId);
  }
  assertCurrent() { if(this.failure)throw this.failure; assertMemoryBundle(this.bundle,this.access); }
  sessionStarted(sessionId:string) { bindMemoryDisclosureSession(this.bundle.bundleId,sessionId); }
  accepted() {
    if(this.failure)throw this.failure;
    if(!this.delivered){deliverMemoryDisclosure(this.bundle.bundleId,this.access);this.delivered=true;}
  }
  /** Event subscribers cannot throw out of the shared bus or skip capability cleanup. */
  completed(ok:boolean) { if(ok||this.observedOutput)try { this.accepted(); } catch(error) { this.failure=error; } }
  output(messageId:string) { this.observedOutput=true; linkMemoryDisclosureOutput(this.bundle.bundleId,messageId); }
}

/** Session shutdown can overlap checkpoint publication. Build only after that
 * await, keeping the original authority snapshot so revocation still fails. */
export async function buildMemoryBundleAfterReset(
  query: string, access: MemoryAccess, bridge: MemorySearchBridge,
  reset: () => Promise<void>, options: Parameters<typeof buildMemoryBundle>[3] = {},
) {
  assertMemoryAccess(access);
  await reset();
  assertMemoryAccess(access);
  return buildMemoryBundle(query, access, bridge, options);
}
