// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// r2.2 helpers extracted from f5cb2d49c:codex-hook.ts; one table/map for all engines.
import { ASK_STOP_NOTE } from "./ask-stop.ts";
/** Fixed model-facing control text; shared with the driver's server-side answers. */
export const CARD_ANSWERED_NOTE = "The owner has now answered the approval you were waiting for. If a code cell is still running, call wait on it to get the result. Then report what really happened, and correct anything you said earlier that turned out not to be true.";
export const DENY_TIMEOUT_NOTE = "Murage: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const denyFrame = (reason: string): string => JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
} });
/** LASTRESORT §2: these are the only bytes a bound hook may write to stdout. */
export const HOOK_CONTROL_FRAMES = Object.freeze({
  allow: "",
  "deny.policy": denyFrame("Murage did not allow this call"),
  "deny.ask": denyFrame(ASK_STOP_NOTE),
  "deny.owner": denyFrame("The owner did not allow this call. Do not try it again; carry on without it or ask the owner."),
  "deny.timeout": denyFrame(DENY_TIMEOUT_NOTE),
  "deny.ended": denyFrame("Murage: the turn ended"),
  "deny.unchecked": denyFrame("Murage could not check this call"),
  "deny.nohook": denyFrame("Murage held this call back because its check is not ready yet. Carry on without it for now, or try it again later."),
  "stop.end": "",
  "stop.block.card": JSON.stringify({ decision: "block", reason: CARD_ANSWERED_NOTE }),
  "session.ok": "",
});
export type HookCode = keyof typeof HOOK_CONTROL_FRAMES;


const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
/** The single server map: runtime content never becomes a control frame.
 * Session errors deliberately use deny.unchecked: SessionStart rejects it (exit 2), so no false proof is created. */
export function hookCodeOf(event: string, answer: unknown): HookCode {
  const a = record(answer);
  if (event === "SessionStart") return a?.ok === true && !a.error ? "session.ok" : "deny.unchecked";
  if (event === "Stop" || event === "SubagentStop") {
    if (a?.error) return "stop.end";
    return a?.decision === "block" && a.reason === CARD_ANSWERED_NOTE ? "stop.block.card" : "stop.end";
  }
  if (!a || a.error || (a.decision !== "allow" && a.decision !== "deny")) return "deny.unchecked";
  if (a.decision === "allow") return a.updatedInput !== undefined || a.additionalContext !== undefined ? "deny.policy" : "allow";
  if (a.source === "nohook") return "deny.nohook";
  if (a.source === "owner") return "deny.owner";
  if (a.reason === ASK_STOP_NOTE) return "deny.ask";
  if (a.reason === DENY_TIMEOUT_NOTE) return "deny.timeout";
  if (a.reason === "Murage: the turn ended") return "deny.ended";
  if (a.reason === "Murage could not check this call") return "deny.unchecked";
  return "deny.policy";
}


export const PRE_TOOL_CODES = Object.freeze(["allow", "deny.policy", "deny.ask", "deny.owner", "deny.timeout", "deny.ended", "deny.unchecked", "deny.nohook"] as const);
export type PreToolCode = typeof PRE_TOOL_CODES[number];
export type DenyCode = Exclude<PreToolCode, "allow">;
export const HOOK_DENY_REASONS = Object.freeze(Object.fromEntries(PRE_TOOL_CODES.filter(code => code !== "allow")
  .map(code => [code, JSON.parse(HOOK_CONTROL_FRAMES[code]).hookSpecificOutput.permissionDecisionReason])) as Record<DenyCode, string>);
export const AGY_CONTROL_FRAMES = Object.freeze(Object.fromEntries(PRE_TOOL_CODES.map(code => [code,
  JSON.stringify(code === "allow" ? { decision: "allow" } : { decision: "deny", reason: HOOK_DENY_REASONS[code] }),
])) as Record<PreToolCode, string>);
export const PI_CONTROL_FRAMES = Object.freeze(Object.fromEntries(PRE_TOOL_CODES.filter(code => code !== "allow")
  .map(code => [code, Object.freeze({ block: true as const, reason: HOOK_DENY_REASONS[code] })])) as Record<DenyCode, Readonly<{ block: true; reason: string }>>);

/** No extra fields and no codes belonging to Stop or SessionStart. */
export function preToolCode(answer: unknown): PreToolCode {
  const a = record(answer);
  return a && Object.keys(a).length === 1 && typeof a.code === "string" && (PRE_TOOL_CODES as readonly string[]).includes(a.code)
    ? a.code as PreToolCode : "deny.unchecked";
}

/** Generated scripts supply writeSync. This is the r2.2 complete synchronous write loop. */
export const CONTROL_WRITE_SOURCE = `const writeAll = (fd, text) => {
  const bytes = Buffer.from(text, "utf8");
  for (let at = 0; at < bytes.length;) { const n = writeSync(fd, bytes, at, bytes.length - at); if (n === 0) throw new Error("CONTROL_WRITE_FAILED"); at += n; }
};`;
/** Same structural check in generated hooks and the in-process Pi extension. */
export const PRE_TOOL_CODE_SOURCE = `const PRE_CODES = new Set(${JSON.stringify(PRE_TOOL_CODES)});
const preToolCode = (answer) => {
  const code = answer && typeof answer === "object" && !Array.isArray(answer)
    && Object.keys(answer).length === 1 && typeof answer.code === "string" ? answer.code : null;
  return PRE_CODES.has(code) ? code : "deny.unchecked";
};`;

/** Tier F: narrowing cannot be applied in Pi after the server release; deny that call. */
export function piGateControlAnswer(decision: { behavior: "allow" | "deny" | "answer"; message?: string; source?: "narrow"; updatedInput?: Record<string, unknown> }): { code: HookCode } {
  return { code: hookCodeOf("PreToolUse", decision.behavior === "allow"
    ? { decision: "allow", ...(decision.updatedInput !== undefined || decision.source === "narrow" ? { updatedInput: decision.updatedInput ?? {} } : {}) }
    : { decision: "deny", reason: decision.message, ...(decision.source === "narrow" ? {} : { source: "owner" }) }) };
}
