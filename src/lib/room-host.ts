// A room call's side of the voice host (server/voice/voice-host-route.ts
// voiceHostRoomState). Pure: GroupCallView.tsx owns the speaker, the mic and
// the store; this decides who answers, what they hear and what they remember.
import type { Bot, Group, Message } from "@/state/store";
import { roomRespondersForComposer } from "./group-routing";
import type { CallHandDown, HostTurnInput, RoomHeard } from "./voice-host";

type HostEntry = HostTurnInput["history"][number];

/** The one member whose voice answers this (routed) line, or null when the
 *  line goes to the room engines as before: everyone, several names, a
 *  mentions-only room nobody was named in, or a bot-to-bot room. */
export function roomHostMember(routedText: string, members: Bot[], group: Pick<Group, "defaultResponder" | "dm">): Bot | null {
  if (group.dm) return null;
  const responders = roomRespondersForComposer(routedText, members, group);
  return responders.length === 1 ? responders[0] : null;
}

/** What the member's voice is told the owner said: the line without its
 *  leading @address. */
export function spokenToMember(routedText: string, member: Pick<Bot, "name">): string {
  const text = routedText.trim();
  const tag = `@${member.name}`;
  if (!text.toLowerCase().startsWith(tag.toLowerCase())) return text;
  const rest = text.slice(tag.length);
  if (rest && !/^[\s,.!?:;-]/.test(rest)) return text; // "@Sa" is not "@Sable"
  return rest.replace(/^[\s,.!?:;-]+/, "") || member.name;
}

/** The room message a hand-down becomes. Its authority is the owner's own
 *  captured words for the turn, verbatim: the voice host's `request` is model
 *  output (it may carry a member's reply or web text), so it never decides
 *  what is sent. Routing is the responder pin's job, not the text's. A
 *  hand-down with no owner utterance behind it (one the host inferred from
 *  its own words) sends nothing. */
export function handDownMessage(ownerWords: string, _hostRequest?: string): { text: string } | null {
  return ownerWords.trim() ? { text: ownerWords } : null;
}

const HISTORY_MAX = 12;
const HEARD_MAX = 6;
/** Kept per call, longer than what one member is told, so the cap applies
 *  after the member's own exchanges are filtered out. */
const HEARD_KEEP = 60;

/** Each member's own host history and hand-downs on this call, and what the
 *  owner and each member's voice said, for the others to be told. */
export class RoomHostMemory {
  private histories = new Map<string, HostEntry[]>();
  private downs = new Map<string, CallHandDown[]>();
  private heard: Array<RoomHeard & { memberId: string }> = [];

  history(memberId: string): HostEntry[] {
    return this.histories.get(memberId) ?? [];
  }

  handDowns(memberId: string): CallHandDown[] {
    return this.downs.get(memberId) ?? [];
  }

  /** Update one hand-down's record in place (a receipt arrived, a cancel). */
  updateHandDown(memberId: string, id: string, patch: Partial<CallHandDown>): void {
    this.downs.set(memberId, this.handDowns(memberId).map((h) => (h.id === id ? { ...h, ...patch } : h)));
  }

  /** This member's hand-downs that are accepted into the room's queue (not sent straight away) and may not have started. */
  waitingHandDowns(memberId: string): CallHandDown[] {
    return this.handDowns(memberId).filter((h) => h.state === "accepted" && h.queued === true && Boolean(h.requestId));
  }

  addHandDown(memberId: string, handDown: CallHandDown): void {
    this.downs.set(memberId, [...this.handDowns(memberId), handDown].slice(-HISTORY_MAX));
  }

  record(member: Pick<Bot, "id" | "name">, owner: string, host: HostEntry): void {
    const keep = host.text || host.handDown ? [host] : [];
    this.histories.set(member.id, [...this.history(member.id), { role: "owner" as const, text: owner }, ...keep].slice(-HISTORY_MAX));
    if (host.text) this.heard = [...this.heard, { memberId: member.id, member: member.name, owner, reply: host.text }].slice(-HEARD_KEEP);
  }

  heardBy(memberId: string): RoomHeard[] {
    return this.heard.filter((e) => e.memberId !== memberId).slice(-HEARD_MAX).map(({ member, owner, reply }) => ({ member, owner, reply }));
  }
}

/** The longest the floor outlasts the owner's silence: it is counted from
 *  the LAST partial, so a long sentence never loses it mid-speech. */
export const FLOOR_MAX_MS = 8_000;

/** The owner has the floor while words are coming in: the room's speech
 *  queue waits on it, so a reply that lands mid-sentence never closes the
 *  microphone on them. Released by their finished line, an interrupt, or
 *  recognition going quiet for the cap (a recognizer that never finishes
 *  cannot block the room). When the cap is hit the line heard so far is
 *  finalised first (`onExpire`), never discarded. */
export class OwnerFloor {
  private waiters: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private line = "";

  constructor(
    private readonly maxMs = FLOOR_MAX_MS,
    private readonly onExpire?: (accumulated: string) => void,
  ) {}

  get held(): boolean {
    return this.timer !== null;
  }

  /** Words are coming in: take the floor, or keep it, and restart the quiet clock. */
  take(partial = ""): void {
    // an identical partial is no new speech: it does not restart the clock
    if (partial.trim() && partial === this.line && this.timer !== null) return;
    if (partial.trim()) this.line = partial;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const line = this.line.trim();
      this.timer = null;
      try {
        if (line) this.onExpire?.(line);
      } finally {
        this.release();
      }
    }, this.maxMs);
  }

  release(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.line = "";
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  wait(): Promise<void> {
    return this.timer === null ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
  }
}

type Dispatch = (action: Record<string, unknown>) => void;

/** Cancel this member's hand-downs that are still waiting in the room's
 *  queue. Only a send that was actually queued has a queue row to cancel. A
 *  record becomes cancelled only when the cancel succeeds; if the work has
 *  started or finished meanwhile the cancel is refused, nothing is shown and
 *  the receipt or the transcript says what became of it. */
export function cancelWaitingHandDowns(memory: RoomHostMemory, memberId: string, ctx: { groupId: string; threadId: string }, dispatch: Dispatch): void {
  for (const handDown of memory.waitingHandDowns(memberId)) {
    dispatch({
      type: "cancelGroupQueued",
      groupId: ctx.groupId,
      threadId: ctx.threadId,
      queueId: handDown.requestId,
      onDone: () => memory.updateHandDown(memberId, handDown.id, { state: "cancelled" }),
      onError: () => true,
    });
  }
}

/** Whether a hand-down's work is starting or running: its message is not on
 *  the transcript yet, or it is the owner's latest line (the member's turn
 *  after it is the one in flight). Earlier ones have finished. */
export function handDownLive(handDown: CallHandDown, messages: Message[]): boolean {
  if (!handDown.sendId) return false;
  let at = -1;
  let latestOwner = -1;
  messages.forEach((m, i) => {
    if (m.role === "user" && m.kind === "text") {
      latestOwner = i;
      if (m.sendId === handDown.sendId) at = i;
    }
  });
  return at < 0 || at === latestOwner;
}

/** Interrupt the member's running turn, and relabel only the hand-downs that
 *  are starting or running. Finished ones keep their state. */
export function interruptHandDowns(memory: RoomHostMemory, memberId: string, ctx: { groupId: string }, messages: Message[], dispatch: Dispatch): void {
  dispatch({ type: "interruptGroup", groupId: ctx.groupId });
  for (const handDown of memory.handDowns(memberId)) {
    if (handDown.state === "accepted" && handDownLive(handDown, messages)) memory.updateHandDown(memberId, handDown.id, { state: "cancelled" });
  }
}

/** The floor's quiet cap ran out. An open approval or question keeps the
 *  line for itself (the recognizer's final line reaches that handler), so it
 *  is neither finalised nor sent to the room. */
export function expireFloorLine(o: {
  live: boolean;
  listening: boolean;
  approvalOpen: boolean;
  questionOpen: boolean;
  line: string;
  final: (line: string) => string | null;
  send: (said: string) => void;
}): "sent" | "held" | "ignored" {
  if (!o.live || !o.listening) return "ignored";
  if (o.approvalOpen || o.questionOpen) return "held";
  const whole = o.final(o.line);
  if (whole === null) return "ignored";
  o.send(whole);
  return "sent";
}
