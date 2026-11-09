// U4 S3 (upstream D39 2d6694ff9, 703dd46cd): a hand-off can say what "finished" means for it. The asking bot writes it, so it is
// bot text that reaches the person (under the hand-off row) and the teammate (in its brief): it is bounded and checked here, at the
// one place it enters, before anything is written.
import { redactSecretsInText } from "./redact.ts";

export const DONE_WHEN_MAX_CHARS = 280;

export type DoneWhenRead = { ok: true; value?: string } | { ok: false; error: string };

/** Absent or blank: no field. Over 280 characters: refused. A value redaction would change (it carries something that reads as a
 * secret): dropped, never stored, shown or passed on. Otherwise one line, inner whitespace folded. */
export function readDoneWhen(raw: unknown): DoneWhenRead {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") return { ok: false, error: "done_when must be text" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true };
  if ([...trimmed].length > DONE_WHEN_MAX_CHARS) return { ok: false, error: `done_when is longer than ${DONE_WHEN_MAX_CHARS} characters` };
  // brackets folded to parentheses: the line cannot close the "[Done when: ...]" marker and read as a new instruction
  const line = trimmed.replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")");
  if (redactSecretsInText(line) !== line) return { ok: true };
  return { ok: true, value: line };
}

/** The line the teammate's brief carries. */
export function doneWhenBriefLine(value: string | undefined): string {
  // read again at the moment it is briefed: a restored or re-queued value is bounded and checked like a new one
  const read = readDoneWhen(value);
  return read.ok && read.value ? `\n\n[Done when: ${read.value}]` : "";
}
