import type { RuntimeEvent } from "../contracts.ts";
export type HighLevelCallClass = "highlevel" | "other" | "inert";
export interface TrustedCallIdentity { source: "fuigo_stamp" | "claude_name" | "codex_server" | "resolve_call"; server: string; tool?: string }
/** PROVISIONAL INTERFACE: C4 implements trusted identity relaxation; S0 never relaxes a marked thread. */
export class HighLevelCallLedger {
  private readonly marked: (threadId: string) => boolean;
  constructor(marked: (threadId: string) => boolean) { this.marked = marked; }
  note(threadId: string, _generation: string, _itemId: string, _identity?: TrustedCallIdentity): HighLevelCallClass { return this.marked(threadId) ? "highlevel" : "inert"; }
  classOf(threadId: string, generation: string, itemId: string): HighLevelCallClass { return this.note(threadId, generation, itemId); }
  turnEnded(_threadId: string): void {}
}
/** PROVISIONAL INTERFACE: hold marked events until C4 supplies the sink-safe projector. */
export function scrubHighLevelEvent(event: RuntimeEvent, cls: HighLevelCallClass): RuntimeEvent {
  if (cls === "highlevel") throw new Error("HighLevel event projector is not installed");
  return event;
}
