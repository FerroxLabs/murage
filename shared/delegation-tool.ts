// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot handing work to another bot, recognised by its tool name on every
// engine. The same Murage tool reaches the owner under many spellings:
// `delegate_bot` (bare), `mcp__agents__delegate_bot` (Claude, Codex),
// `agents__delegate_bot` (Fuigo, inside `use_tool`), `agents_delegate_bot`
// (Pi), `Agents_delegate_bot` (an ACP "other" approval's detail), and other
// harnesses name their own (`message_agent`, `handoff`). Whatever the
// spelling, the owner reads "Asked Draft Partner to draft the intro", never a
// generic file or tool phrase picked up from the words of the task.

export type DelegationKind = "delegate" | "ask" | "message";

/** Tool names, after normalising, with the kind each one is. A name matches
 * when it IS one of these or ends with "_" plus one (a mount prefix). */
const NAMES: ReadonlyArray<readonly [string, DelegationKind]> = [
  ["delegate_bot", "delegate"],
  ["delegate_task", "delegate"],
  ["delegate_to_agent", "delegate"],
  ["delegate_to_bot", "delegate"],
  ["handoff", "delegate"],
  ["hand_off", "delegate"],
  ["handoff_to_agent", "delegate"],
  ["transfer_to_agent", "delegate"],
  ["assign_task", "delegate"],
  ["ask_bot", "ask"],
  ["ask_agent", "ask"],
  ["message_agent", "message"],
  ["message_bot", "message"],
  ["send_message_to_agent", "message"],
];

/** Tool names that only wrap or stand in for the real tool, which is then
 * named in the detail (Grok's ACP "other", Fuigo's `use_tool`). */
const GENERIC = new Set(["other", "use_tool", "call_tool", "tool"]);

function normalise(name: string): string {
  return name
    .trim()
    .replace(/^mcp__[^_]+__/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function kindOfName(name: string): DelegationKind | null {
  const bare = normalise(name);
  if (!bare) return null;
  for (const [known, kind] of NAMES) {
    if (bare === known || bare.endsWith(`_${known}`)) return kind;
  }
  return null;
}

/** The first JSON object in a detail, unwrapped from a tool wrapper. */
function detailObject(detail: string): Record<string, unknown> | null {
  const start = detail.indexOf("{");
  const end = detail.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(detail.slice(start, end + 1));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const inner = row.tool_input ?? row.toolInput ?? row.arguments ?? row.input;
    return inner && typeof inner === "object" && !Array.isArray(inner) ? { ...row, ...(inner as Record<string, unknown>) } : row;
  } catch {
    return null;
  }
}

/** Which kind of hand-off a tool call is, from its name, or for a wrapper or
 * an ACP "other", from the tool named at the head of its detail. */
export function delegationToolKind(tool: string, detail = ""): DelegationKind | null {
  const own = kindOfName(tool);
  if (own) return own;
  const bare = tool.trim().toLowerCase();
  if (!GENERIC.has(bare) && !/\s/.test(bare) && bare !== "") return null;
  const head = detail.match(/^\s*([A-Za-z][\w.:/-]*)/)?.[1];
  if (head) {
    const kind = kindOfName(head);
    if (kind) return kind;
  }
  const row = detailObject(detail);
  const named = row?.tool_name ?? row?.toolName ?? row?.name;
  return typeof named === "string" ? kindOfName(named) : null;
}

const WHO_FIELDS = ["bot_name", "botName", "agent_name", "agentName", "bot_id", "botId", "bot", "agent", "agent_id", "agentId", "target", "to", "recipient"];
const TASK_FIELDS = ["message", "task", "prompt", "instructions", "request", "goal", "text", "content"];

/** A machine id is never shown; a name the bot used is. */
function readableName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^@/, "");
  if (!name || name.length > 40) return null;
  if (/^[0-9a-f-]{16,}$/i.test(name)) return null;
  if (/^(bot|agent)[_-]?[a-z0-9]{6,}$/i.test(name) && /\d/.test(name)) return null;
  if (/^[a-z0-9]{12,}$/i.test(name) && /\d/.test(name)) return null;
  if (/[{}<>\n]/.test(name)) return null;
  return name;
}

/** The task as a short phrase that follows "to": the first sentence, without
 * a polite lead-in, cut at a word near 60 characters. */
function taskPhrase(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.replace(/\s+/g, " ").trim();
  text = text.split(/(?<=[.!?])\s/)[0] ?? text;
  for (let i = 0; i < 3; i++) text = text.replace(/^(please|pls|hey|hi|ok|okay|can you|could you|would you|will you)\b[,!]?\s*/i, "");
  text = text.replace(/[.!?\s]+$/, "");
  if (!text || /^[{[]/.test(text)) return null;
  if (/^[A-Z][a-z]/.test(text)) text = text[0].toLowerCase() + text.slice(1);
  if (text.length > 60) {
    const cut = text.slice(0, 60);
    const space = cut.lastIndexOf(" ");
    text = `${(space > 30 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "")}…`;
  }
  return text;
}

export interface DelegationRequest {
  kind: DelegationKind;
  /** The teammate's name, or null when only an id was given. */
  who: string | null;
  /** What was asked, as a short phrase, or null. */
  task: string | null;
}

/** The hand-off a tool call makes, or null when it is not one. A detail that
 * is not JSON is the message itself (a peer approval card's subtitle). */
export function delegationRequest(tool: string, detail = "", hint?: { who?: string }): DelegationRequest | null {
  const kind = delegationToolKind(tool, detail);
  if (!kind) return null;
  const row = detailObject(detail);
  let who: string | null = readableName(hint?.who);
  let task: string | null = null;
  if (row) {
    for (const field of WHO_FIELDS) { who ??= readableName(row[field]); if (who) break; }
    for (const field of TASK_FIELDS) { task = taskPhrase(row[field]); if (task) break; }
  } else if (kindOfName(tool) && !/^\s*[A-Za-z][\w.:/-]*\s*$/.test(detail)) {
    task = taskPhrase(detail);
  }
  return { kind, who, task };
}

/** The hand-off in plain words, as "Name wants to ..." or "Can I ...?" reads
 * it: "ask Draft Partner to draft the intro". */
export function delegationAction(tool: string, detail = "", hint?: { who?: string }): string | null {
  const request = delegationRequest(tool, detail, hint);
  if (!request) return null;
  const who = request.who ?? "a teammate";
  if (request.kind === "ask") return `ask ${who} a question`;
  if (request.kind === "message") return `send ${who} a message`;
  return request.task ? `ask ${who} to ${request.task}` : `hand work to ${who}`;
}

/** The live working line while the hand-off runs: "Handing work to Draft
 * Partner". */
export function delegationLiveLine(tool: string, input?: unknown): string | null {
  const detail = input === undefined ? "" : typeof input === "string" ? input : (() => { try { return JSON.stringify(input); } catch { return ""; } })();
  const request = delegationRequest(tool, detail);
  if (!request) return null;
  const who = request.who ?? "a teammate";
  if (request.kind === "ask") return `asking ${who}`;
  if (request.kind === "message") return `messaging ${who}`;
  return `handing work to ${who}`;
}
