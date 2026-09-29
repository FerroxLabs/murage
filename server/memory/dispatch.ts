import type { MemoryBundle } from "../../shared/memory.ts";
import { database } from "../database.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import type { MemorySearchBridge } from "./search.ts";
import { assertMemoryBundle, buildMemoryBundle, memoryHandleRecord } from "./bundle.ts";
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
  /** Resolve a turn-local handle (m1, m2, …) from the remembered-context frame
   * this receipt delivered. Only the capability that dispatched the turn may
   * resolve its handles: the same bot, thread and generation (MEMJSON2). */
  resolveHandle(handle:string,access:MemoryAccess):{id:string;version:number}|undefined {
    if(access.botId!==this.access.botId||access.threadId!==this.access.threadId||access.generation!==this.access.generation)return undefined;
    return memoryHandleRecord(this.bundle,handle);
  }
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

/** The owner-facing reason a turn was refused over its pinned memory, in plain
 * words (0.1.61 final check D3: the raw code reached the room twice per bot).
 * `subject` names whose pins they are ("its", "Moss's"). Undefined for any
 * other failure, which keeps its own message. */
export function pinnedMemoryFailure(error: unknown, subject: string): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("MEMORY_PIN_OVERFLOW")) return `${subject} pinned memories are too long for this model. Unpin some in Memory, or choose a model that takes more context.`;
  if (message.startsWith("MEMORY_PIN_UNAVAILABLE")) return `${subject} pinned memory rests on something that was deleted or changed. Unpin it or fix it in Memory.`;
  return undefined;
}

/** Murage's line when a turn went without an owner pin because the pin rests
 * on a reply bots no longer see (bundle.ts withheldPins; 0.1.61 third check,
 * P1). Said once per thread for each pinned version, so a room of members
 * each leaving it out hears it once. Undefined when nothing new was left out. */
export const WITHHELD_PIN_LINE = "Bots were not given a pinned note: it uses a reply they no longer see. Unpin it in Memory, then pin a newer one if you still want it.";
const withheldPinsNoted = new Map<string, Set<string>>();
export function withheldPinLine(threadId: string, bundle: MemoryBundle & {withheldPins?: ReadonlyArray<{id: string; version: number}>}): string | undefined {
  if (!bundle.withheldPins?.length) return undefined;
  let noted = withheldPinsNoted.get(threadId);
  if (!noted) {
    if (withheldPinsNoted.size >= 512) withheldPinsNoted.delete(withheldPinsNoted.keys().next().value!);
    noted = new Set(); withheldPinsNoted.set(threadId, noted);
  }
  const fresh = bundle.withheldPins.map(pin => `${pin.id}@${pin.version}`).filter(key => !noted.has(key));
  for (const key of fresh) noted.add(key);
  return fresh.length ? WITHHELD_PIN_LINE : undefined;
}
