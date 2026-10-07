// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What an approval card says about the action it asks about, built from the
// engine's own structured request and never from the model's prose.
//
// Two jobs live here:
//   1. Claude cards carry the WHOLE tool input as JSON text (`toolInput`), so
//      a card for a fetch tool shows `method: "DELETE"` and not only the url.
//   2. Codex and ACP cards headline the real target (the command, the files)
//      and keep the model's own `reason` as a labelled, secondary line.
import { approvalSummaryIsCut } from "../shared/approval-summary.ts";
import { redactSecretsForCard } from "./redact.ts";

/** Cap on the tool input text a card carries. A cut is always marked. */
export const TOOL_INPUT_MAX_BYTES = 16 * 1024;

/** Label for the model's own explanation, shown under the real target. */
export const MODEL_REASON_LABEL = "Model's reason: ";

/** Cap on one string value inside the tool input. Each value is cut on its
 * own, so a long value never pushes a later key (a url, a method) out of the
 * text. A cut value ends with "…[N bytes more]". */
export const TOOL_INPUT_VALUE_MAX_BYTES = 2048;

/** A string value cut at the per-value cap ends with this marker. */
const VALUE_CUT = /…\[\d+ bytes more\]/;
const TOTAL_CUT = /\n\[truncated, \d+ bytes more\]$/;

/** True when the text was cut as a whole (more keys than fit the cap). The
 * owner cannot see all of it, so the card must not offer "always allow". */
export function toolInputIsTruncated(text: string | undefined): boolean {
  return Boolean(text && (TOTAL_CUT.test(text) || VALUE_CUT.test(text)));
}

/** True when the owner cannot see all of what the card asks for: a cut tool
 * input, or (no tool input, as for ACP shell and pi bash) a cut summary. */
export function approvalIsCut(toolInput: string | undefined, summary: string | undefined): boolean {
  return toolInputIsTruncated(toolInput) || (!toolInput && approvalSummaryIsCut(summary));
}

function capValue(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= TOOL_INPUT_VALUE_MAX_BYTES) return value;
  let used = 0;
  let end = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > TOOL_INPUT_VALUE_MAX_BYTES) break;
    used += size;
    end += ch.length;
  }
  return `${value.slice(0, end)}…[${bytes - used} bytes more]`;
}

/** The full tool input as one JSON text, credential values masked (by key
 * name and by content), each string value capped (not a shell `command`), the whole bounded to about
 * 16 KB. When the keys alone do not fit, the text ends with an explicit
 * "[truncated, N bytes more]" marker (N counts the UTF-8 bytes left out).
 * Returns undefined for an empty or unserializable input. */
export function boundedToolInput(input: unknown, maxBytes = TOOL_INPUT_MAX_BYTES): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  let text: string | undefined;
  try {
    // Mask first, on the structure (so a short password under a secret-named
    // key goes too) and before the JSON escapes newlines (so a PEM mask keeps
    // the text valid JSON), then cap each value.
    // A shell command is shown whole (only the overall cap can cut it), so
    // its tail never hides behind the per-value cap.
    const redacted = redactSecretsForCard(input);
    text = JSON.stringify(redacted, function (this: unknown, key: string, value: unknown) {
      if (typeof value !== "string") return value;
      if (key === "command" && this === redacted) return value;
      return capValue(value);
    });
  } catch {
    return undefined;
  }
  if (!text || text === "{}") return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    end += ch.length;
  }
  return `${text.slice(0, end)}\n[truncated, ${bytes - used} bytes more]`;
}

const PLAIN_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One argv element, quoted the way a POSIX shell would need it. */
function shellQuote(arg: string): string {
  if (arg !== "" && PLAIN_ARG.test(arg)) return arg;
  if (/[\p{Cc}\p{Cf}]/u.test(arg)) {
    // A newline or a hidden character (a bidi override) would print raw, so
    // show it as an ANSI-C escape.
    const body = [...arg].map((ch) => {
      if (ch === "'") return "\\'";
      if (ch === "\\") return "\\\\";
      if (ch === "\n") return "\\n";
      if (ch === "\r") return "\\r";
      if (ch === "\t") return "\\t";
      if (/[\p{Cc}\p{Cf}]/u.test(ch)) {
        const code = ch.codePointAt(0)!;
        return code > 0xffff ? `\\U${code.toString(16).padStart(8, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
      }
      return ch;
    }).join("");
    return `$'${body}'`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** An argv array as the command line it stands for. */
export function shellJoin(argv: readonly unknown[]): string {
  return argv.map((a) => shellQuote(String(a))).join(" ");
}

/** The command text of an engine request: a string as given, an argv array
 * joined with shell quoting. Undefined when neither is usable. */
export function commandText(command: unknown): string | undefined {
  if (typeof command === "string") return command.trim() ? command : undefined;
  if (Array.isArray(command) && command.length > 0) return shellJoin(command);
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** File paths a Codex edit approval names, from its structured fields only:
 * the legacy `fileChanges` map (keys are paths) and the v2 `grantRoot`. */
export function codexEditTargets(params: any, itemPaths?: readonly string[]): string[] {
  const out: string[] = [];
  const changes = params?.fileChanges;
  if (changes && typeof changes === "object" && !Array.isArray(changes)) out.push(...Object.keys(changes));
  if (!out.length && itemPaths?.length) out.push(...itemPaths);
  return out.filter((p) => p !== "");
}

/** The card's headline and secondary reason for a Codex shell or edit
 * approval. The headline is the real command or the files; the model's
 * `reason` is returned apart so the card can label it. */
export function codexApprovalText(
  method: string,
  params: any,
  tool: string,
  itemPaths?: readonly string[],
): { summary: string; reason?: string } {
  const reason = nonEmpty(params?.reason);
  const command = commandText(params?.command);
  if (command) return { summary: command, ...(reason ? { reason } : {}) };
  if (tool === "edit" || method === "applyPatchApproval" || method === "item/fileChange/requestApproval") {
    const targets = codexEditTargets(params, itemPaths);
    const root = nonEmpty(params?.grantRoot);
    const where = targets.length ? targets.join(", ") : root ? `all files under ${root}` : undefined;
    if (where) return { summary: where, ...(reason ? { reason } : {}) };
    // No files named: the model's reason is not a target, so it stays labelled.
    return { summary: tool === "edit" ? "edit (files not named)" : tool, ...(reason ? { reason } : {}) };
  }
  // Nothing structured to show: the reason is all there is, so it stays the
  // headline (it is the only text), but it is still not dropped.
  return { summary: reason ?? tool };
}

/** The text a card shows under its title: the full tool input when the
 * engine sent one, else the summary, then the model's reason, labelled. */
export function cardDetail(event: { summary: string; toolInput?: string; reason?: string }): string {
  if (event.toolInput) return event.toolInput;
  if (event.reason && event.reason !== event.summary) return `${event.summary}\n\n${MODEL_REASON_LABEL}${event.reason}`;
  return event.summary;
}

/** What audit rows, risk rating and the tray read from a card: the engine's
 * one-line summary, else the subtitle (free-text cards have no `summary`). */
export function cardAuditSummary(card: { summary?: string; subtitle?: string } | undefined): string | undefined {
  return card?.summary ?? card?.subtitle;
}
