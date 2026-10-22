// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Ask hard stop for engines that cannot ask before every change (Cursor, OpenClaw, Antigravity).
//
// Real-CLI probes (2026-10-21) found these three change things at Ask with no card: Cursor writes inside the project,
// OpenClaw writes (no OpenClaw mode asks), and Antigravity runs shell commands and writes under `--mode accept-edits`.
// At Ask (SendTurnInput.askLevel) each one runs read-only: it may read and plan, and every file change or command is
// refused before it runs, by the engine's own read-only switch (Cursor's "ask" session mode, OpenClaw's "read-only"
// session permission mode, an Antigravity PreToolUse hook that allows only reads). Fail closed: a tool that cannot be
// shown to be a read is refused, and a turn whose read-only switch cannot be set does not run. Auto and Full access are
// unchanged. The bot then shows one plain note, ASK_STOP_NOTE.

/** The one note the owner sees when a change was refused at Ask. */
export const ASK_STOP_NOTE = "At Ask, I can read and plan. Choose Auto to let me make changes.";

/** Put before the prompt of an Ask turn on these engines, so the model does not try a change it cannot make and,
 *  when the owner asked for one, ends with the same note (the engine's own refusal text names its own modes). */
export const ASK_STOP_PROMPT = [
  "[Murage: this bot is at the Ask level for this turn. You can read files and plan, but you cannot change files or run commands.",
  "If the request needs a change or a command, do not attempt it: say what you would do, then end your reply with this line:",
  `${ASK_STOP_NOTE}]`,
].join(" ");

/** The stop reason a turn settles with (ok:true) when Murage itself halted it at the Ask boundary, because a change ran
 *  anyway (Antigravity: the hook did not hold). ACP engines (Cursor, OpenClaw, Grok) halt through session/cancel and
 *  settle "cancelled"; a refused change there does not halt the turn, and a refused start fails it (ok:false). */
export const ASK_STOP_REASON = "ask_stop";
/** Every Ask stop reason a driver may settle with: turnStopped (../turn-outcome.ts) treats each as a stop. */
export const ASK_STOP_REASONS = [ASK_STOP_REASON] as const;

/** The note for an OpenClaw too old to take a session permission mode (before 2026.8.1): refused Ask turns,
 *  setup's CLI test and engine detection all show this one line. */
export const ASK_STOP_OPENCLAW_OLD_NOTE = "At Ask, this OpenClaw version cannot stop before changes. Choose Auto to let me act, or install OpenClaw 2026.8.1 or newer.";

/** The note for a Grok older than GROK_ASK_HOLD_MIN (grok.ts): its `[permission] ask` rules are not proven there, so
 *  an Ask turn is refused before it runs. */
export const ASK_STOP_GROK_OLD_NOTE = "At Ask, this Grok version cannot stop before changes. Update Grok, or choose Auto to let me act.";

/** An Ask stop that refuses the turn with its own plain note (shown as is, not the generic line). */
export class AskStopRefusal extends Error {
  constructor(note: string) {
    super(note);
    this.name = "AskStopRefusal";
  }
}

/** The line an Ask turn on a read-only engine refuses with when its read-only switch could not be set. */
export function askStopUnavailableLine(engine: string): string {
  return `${engine} could not switch to read-only for this Ask turn, so it did not run. ${ASK_STOP_NOTE}`;
}

/** ACP tool kinds a read-only Ask turn still sends to the owner's card (a read, a search, thinking, a fetch). Every
 *  other kind (edit, delete, move, execute, switch_mode, other, or none) is refused with no card. */
const ASK_STOP_CARD_KINDS: ReadonlySet<string> = new Set(["read", "search", "think", "fetch"]);
export function askStopRefusesKind(kind: unknown): boolean {
  return typeof kind !== "string" || !ASK_STOP_CARD_KINDS.has(kind);
}

/** ACP tool kinds that change something. Seen as completed on a read-only Ask turn, the engine's own read-only
 *  switch did not hold: the turn is stopped at once. */
const ASK_STOP_CHANGE_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move", "execute"]);
export function askStopChangeKind(kind: unknown): boolean {
  return typeof kind === "string" && ASK_STOP_CHANGE_KINDS.has(kind);
}

/** Whether the bot's reply already carries the note (then Murage adds no second one). */
export function replyCarriesAskStopNote(text: string): boolean {
  return text.replace(/\s+/g, " ").includes(ASK_STOP_NOTE);
}
