import type { RuntimeEvent } from "../contracts.ts";
export type HighLevelCallClass = "highlevel" | "other" | "inert";
export interface TrustedCallIdentity { source: "fuigo_stamp" | "claude_name" | "codex_server" | "resolve_call"; server: string; tool?: string }
/** Private, generation-scoped identities supplied by the driver resolver.
 * Unknown calls never inherit another call's classification. */
export class HighLevelCallLedger {
  private readonly marked: (threadId: string) => boolean;
  private readonly calls = new Map<string, HighLevelCallClass>();
  constructor(marked: (threadId: string) => boolean) { this.marked = marked; }
  note(threadId: string, generation: string, itemId: string, identity?: TrustedCallIdentity): HighLevelCallClass {
    const key = JSON.stringify([threadId, generation, itemId]);
    if (!generation || !itemId || !identity || !identity.server) {
      // An amended request that no longer proves its identity must not reuse
      // a previous "other" classification for the same native item.
      this.calls.delete(key);
      return this.classOf(threadId, generation, itemId);
    }
    const classification = identity.server === 'own:highlevel' ? 'highlevel' : 'other';
    const prior = this.calls.get(key);
    // Conflicting identities cannot relax a call already observed as HighLevel.
    // Evicted calls become unproven; capacity must not deny a newly proved call.
    if (!prior && this.calls.size >= 2048) this.calls.delete(this.calls.keys().next().value!);
    this.calls.set(key, prior === 'highlevel' ? prior : classification);
    return this.classOf(threadId, generation, itemId);
  }
  classOf(threadId: string, generation: string, itemId: string): HighLevelCallClass {
    return this.calls.get(JSON.stringify([threadId, generation, itemId])) ?? (this.marked(threadId) ? 'highlevel' : 'inert');
  }
  turnEnded(threadId: string): void {
    for (const key of this.calls.keys()) if (JSON.parse(key)[0] === threadId) this.calls.delete(key);
  }
}
/** PROVISIONAL INTERFACE: hold marked events until C4 supplies the sink-safe projector. */
export function scrubHighLevelEvent(event: RuntimeEvent, cls: HighLevelCallClass): RuntimeEvent {
  if (cls === "highlevel") throw new Error("HighLevel event projector is not installed");
  return event;
}
