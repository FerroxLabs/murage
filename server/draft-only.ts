// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A draft-only bot (store.ts BotRecord.draftOnly, stamped at install from a package agent's `outbound: "draft-only"`) writes
// drafts for the owner to review and send. Design: DRAFT-ONLY-ALLOWLIST-104 (internal design note).
//
// One gate, an allow-list: a draft-only turn runs only on an engine mode that runs no tool, hook or fetch of its own
// (draftOnlyQualifies). Every engine call passes through the registry decorator (harness/draft-only-adapter.ts), which refuses
// the turn on any other engine and cuts the turn down to its one read surface; the Claude driver reads its launch facts again
// before every spawn of a draft-only turn (first launch, relaunch, prewarm). Settings, routines, browser setup, hand-offs and
// channel replies keep their own refusals and holds below.

/** Owner-facing lines. Framed as what the bot does. */
export const DRAFT_ONLY_SETTINGS_REFUSAL = "This bot drafts replies for you to send, so it stays at Ask and works without the browser or a computer.";
export const DRAFT_ONLY_ROUTINE_REFUSAL = "This bot drafts replies for you to send, so its routines run at Ask.";
export const DRAFT_ONLY_BROWSER_REFUSAL = "This bot drafts replies for you to send, so it works without your browser.";
export const DRAFT_ONLY_HANDOFF_REFUSAL = "This bot drafts replies for you to send, so it hands work only to teammates that draft too.";
export const DRAFT_ONLY_COMMAND_REFUSAL = "This bot drafts replies for you to send. It reads and searches, and leaves commands and changes to you.";
export const DRAFT_ONLY_CHANNEL_LINE = "Your reply is drafted in Murage. Open it there to review and send it.";
/** A channel reply whose bot cannot be read any more: held in Murage, never posted. */
export const CHANNEL_HELD_LINE = "This reply is in Murage. Open it there to read it.";
/** The refusal when a draft-only bot's engine mode does not qualify (draftOnlyQualifies). */
export const DRAFT_ONLY_ENGINE_LINE = "This bot writes drafts for you to review and send, and it drafts on Claude or a connected chat model. Choose one of those in this bot's settings and it picks up from here.";
export const DRAFT_ONLY_NOTE = "I write drafts for you to review and send.";
/** The system note every draft-only turn carries (harness/draft-only-adapter.ts). */
export const DRAFT_ONLY_PROMPT = [
  "[Murage: this bot writes drafts for the owner to review and send. Write the draft in your reply.",
  "You have no tools for commands, changes, the web or sending. If the request needs one, say what you would do and leave it to the owner, then end your reply with this line:",
  `${DRAFT_ONLY_NOTE}]`,
].join(" ");

/** A refused draft-only turn: thrown before any engine call, carrying the owner line. */
export class DraftOnlyRefused extends Error {
  readonly status = 409;
  readonly code = "draft_only_engine";
  constructor(line: string = DRAFT_ONLY_ENGINE_LINE) { super(line); this.name = "DraftOnlyRefused"; }
}

/** The facts a draft-only turn is judged on. Each is read by the code that launches (or is about to launch) the engine, never
 *  taken from a caller or a SendTurnInput field. The registry decorator and the early owner checks know the driver and where
 *  it runs; the Claude driver supplies the Claude facts itself before every spawn. */
export interface DraftOnlyMode {
  driverKind: string;
  /** "cloud" when the turn would run on the Cloud computer. */
  runOn?: string;
  /** MURAGE_CLOUD_ROLE=home: the launcher renders its own settings and MCP config. */
  cloudHome?: boolean;
  /** Claude: a managed settings file declares hooks, or one cannot be read (managed settings outrank Murage's flags). */
  managedHooks?: boolean;
  /** Claude: a managed-mcp.json exists (it decides which MCP servers run). */
  managedMcp?: boolean;
  /** Claude: a settings file the launch loads, or a managed one, sets an executable credential or header helper, or cannot
   *  be read. */
  claudeHelpers?: boolean;
  // SEAM (ENGINE-SANDBOX-106): `sandboxed?: boolean`, set only by the launcher that starts the engine inside the Murage OS
  // sandbox, on every launch including retries and prewarm, never by a caller. Adding it is this field, one branch below
  // (`if (mode.sandboxed === true) return { ok: true, surface: "sandboxed" }`) and the "sandboxed" surface.
}
export type DraftOnlySurface = "claude-toolless" | "chat-completions";
export type DraftOnlyVerdict = { ok: true; surface: DraftOnlySurface } | { ok: false; line: string };

/** Chat-completions drivers (drivers/openai-chat.ts): one HTTP POST with no tools field, no process, no files. */
const CHAT_COMPLETIONS_DRIVERS: ReadonlySet<string> = new Set(["openai-compat", "minimax"]);

/** THE gate: whether a draft-only turn may run in this engine mode. An allow-list: an unknown driver is refused. */
export function draftOnlyQualifies(mode: DraftOnlyMode): DraftOnlyVerdict {
  const refused: DraftOnlyVerdict = { ok: false, line: DRAFT_ONLY_ENGINE_LINE };
  if (mode.runOn === "cloud" || mode.cloudHome === true) return refused;
  if (CHAT_COMPLETIONS_DRIVERS.has(mode.driverKind)) return { ok: true, surface: "chat-completions" };
  if (mode.driverKind === "claudeAgent") {
    if (mode.managedHooks === true || mode.managedMcp === true || mode.claudeHelpers === true) return refused;
    return { ok: true, surface: "claude-toolless" };
  }
  return refused;
}

/** What a channel (Telegram, Slack, Discord, WhatsApp) posts for a finished run: a draft-only bot's words stay in Murage as a
 *  draft and the channel gets Murage's own line; a bot that cannot be read any more gets the held line. No output stays no
 *  output, so a failed run says so as before. */
export function channelReplyText(bot: { draftOnly?: true } | null | undefined, output: string | undefined, render: (text: string) => string): string | undefined {
  if (!output) return output;
  if (!bot) return CHANNEL_HELD_LINE;
  return bot.draftOnly === true ? DRAFT_ONLY_CHANNEL_LINE : render(output);
}

/** Whether a member's @mention in a room reply may start the teammate it names: a draft-only speaker (as read at its turn
 *  start or now) starts no one. */
export function draftOnlyMentionAllowed(speaker: readonly ({ draftOnly?: true } | null | undefined)[]): boolean {
  return !speaker.some((bot) => bot?.draftOnly === true);
}

interface PermissionFields {
  autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean; alwaysAllow?: string[];
  computer?: unknown; browser?: boolean; useMyChrome?: boolean;
}
/** The turn's copy of a draft-only bot, at Ask with nothing outside Murage. Applied after every level a routine, a ceiling or a
 *  conversation set, so none of them can lift it. */
export function draftOnlyClamp<T extends PermissionFields>(bot: T): T {
  const fields: PermissionFields = bot;
  fields.autoApprove = false; fields.fullAccess = false; fields.noLimits = false; fields.alwaysAllow = [];
  fields.computer = "off"; fields.browser = false; fields.useMyChrome = false;
  return bot;
}

/** A PATCH body that would lift a draft-only bot past Ask or give it the browser or a computer. */
export function draftOnlySettingsLift(body: Record<string, unknown>): boolean {
  return body.autoApprove === true || body.fullAccess === true || body.noLimits === true || body.acknowledgeFullAccess === true || body.acknowledgeNoLimits === true
    || body.fullAccessChannelMessages === true || body.fullAccessSetupRequests === true
    || (Array.isArray(body.alwaysAllow) && body.alwaysAllow.length > 0)
    || body.browser === true || body.useMyChrome === true || (body.computer !== undefined && body.computer !== "off");
}
