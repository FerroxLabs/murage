// C-M1 · owner: M6 settings-from-chat lane (server and client, one branch) → message renderer (shell), J1 label (find).
// designs/settings-chat-1023/DESIGN.md sections 2-5. A bot finds a setting and shows the setting's own control in its chat;
// only the owner's tap writes, through the same writer route and gates Settings uses.

/** C8 SettingRef (owner: core L0, shared/setting-ref.ts on the sv10 line). Structural copy until sv10 lands on this train. */
export interface SettingRef { id: string; bot?: string; account?: string; device?: string; item?: string; code: string }
/** C12 JournalLookup (owner: core J0, shared/settings-v10/journal.ts on the sv10 line). Structural copy. */
export type JournalActor = { kind: "owner" } | { kind: "bot"; botId: string } | { kind: "murage" } | { kind: "otherProgram"; name?: string };
export interface JournalRow { changeId: string; actor: JournalActor; writer: string; settingId: string; bot?: string; before?: unknown; after?: unknown; at: number }
export type JournalLookup = { state: "saved"; row: JournalRow } | { state: "notSaved" } | { state: "couldNotCheck" };
/** The J0 writer-table row M6 asks core for (never a C12 field). */
export const CHAT_CARD_WRITER = "chat-card";

export type ChatClass = "inline" | "open" | "no";
export type CardOutcome = "changed" | "dismissed" | "superseded" | "withdrawn";
/** The writer a card's tap goes to, fixed at show time: the bot's own model, or one task thread's model. */
export type WriterTarget = { kind: "bot" } | { kind: "task"; taskId: string } | { kind: "app" };

/** One card record. `cardGen` counts per (threadId, id, bot); APPLYING and CHECKING are client-only states. */
export interface SettingCardRecord {
  cardId: string;
  threadId: string;
  botId: string;
  generation: string;
  settingId: string;
  settingBot?: string;
  writerTarget: WriterTarget;
  cardGen: number;
  state: "OPEN" | "SETTLED";
  outcome?: CardOutcome;
  pendingChangeId?: string;
  changeId?: string;
  reason: string;
  createdAt: number;
  settledAt?: number;
}

/** What the client draws: the record plus the live value and the control the writer's gates allow right now. */
export interface SettingCardView {
  card: SettingCardRecord;
  label: string;
  path: string;
  scopeLine: string;
  /** "inline" draws the page's own ChatControl; "open" draws Open in Settings only. */
  control: "inline" | "open";
  /** Why the control is not inline here (desktop-only, Cloud needs Settings). */
  controlNote?: string;
  chatControl?: string;
  value?: unknown;
  /** The value the tap must carry as `expect`. */
  expect?: unknown;
  options?: Array<{ value: string; label: string }>;
}

export interface ApplyRequest { value: unknown; expect: unknown; cardGen: number; changeId: string }
export type ApplyAnswer =
  | { ok: true; card: SettingCardRecord; replay: boolean }
  | { ok: false; code: ApplyRefusal; error: string; card?: SettingCardRecord; live?: unknown };
export type ApplyRefusal = "NOT_OWNER" | "NOT_FOUND" | "BAD_REQUEST" | "SUPERSEDED" | "SETTLED" | "WITHDRAWN" | "VALUE_CHANGED"
  | "COULD_NOT_CHECK" | "NEEDS_SETTINGS" | "WRITER_REFUSED";

/** Tool refusals the bot reads (find/show). */
export type ToolRefusal = "OWNER_ONLY" | "NOT_THIS_BOT" | "NO_HOME" | "NOT_SHOWN_HERE" | "CARD_CAP" | "BAD_REQUEST";

export const SHOW_CAP_PER_TURN = 3;
export const REASON_MAX = 200;
export const FIND_MAX = 5;
export const NOT_KNOWN_YET = "Not known yet";
export const OPEN_TO_SEE = "Open it to see";

/** The bot's reason: plain text, no links, no markdown, 200 characters at most. */
export function plainReason(raw: string): string {
  const text = raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?|ftp|file|mailto|javascript|data):\S*/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/[*_`#>~|<]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, REASON_MAX).join("");
}

/** The canonical card key: (id, bot). code, account, device and item never form part of it (design section 3). */
export function cardKey(threadId: string, ref: Pick<SettingRef, "id" | "bot">): string {
  return JSON.stringify([threadId, ref.id, ref.bot ?? null]);
}
