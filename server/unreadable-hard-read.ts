// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// APPROVALS-SIMPLE-1018 section 4 (Astra r1 H1): the hard-category read an `unreadable` card gets when it opens.
// The always-ask verdict returns before the key and destructive guards run (auto-approve.ts), so "unreadable" alone
// says nothing about keys, deleting or hidden code. Before such a card may join Approve all, the whole text is read
// here, as plain text: the key guard, the destructive guard, and the plain-text subset of the NOLIMITS-UNREADABLE R2
// hiding scan (H1-H9). The stop line (pay, delete, message) is already on the card class. Pure; fail closed: any hit,
// or a text too long to read, keeps the card one at a time.
import { looksDestructive, looksSensitive } from "./auto-approve.ts";

export type UnreadableHold = "sensitive" | "destructive" | "hiding";

const MAX_TEXT = 64 * 1024;
const RUNNER = String.raw`(?:sudo\s+)?(?:env\s+)?(?:[\w./-]*\/)?(?:ba|z|da|k|fi|c|tc)?sh|python[\d.]*|node|deno|bun|perl|ruby|php|pwsh|powershell|osascript|lua|Rscript`;
/** A command starts here: the text's start, a new line, or after ; & | ( { and `then`/`do`. */
const AT = String.raw`(?:^|[\n;&|({]|\b(?:then|do|else)\s)\s*`;

const HIDING: readonly RegExp[] = [
  /\$'/, // H1 ANSI-C quoting
  /(?:^|[\s;&|(`])eval(?=\s|$)/m, // H2 eval
  new RegExp(String.raw`\|\s*(?:${RUNNER})(?=[\s;&|)]|$)`, "m"), // H3 text piped into a shell or interpreter
  new RegExp(String.raw`${AT}(?:${RUNNER})\b[^\n;&|]*<<`, "m"), // H4 heredoc or here-string into one
  /\s-(?:EncodedCommand|EncodedCo\w*|enc|ec)\s+\S/i, // H5 encoded PowerShell
  /(?:pwsh|powershell)(?:\.exe)?\b[^\n]*\s-e\s+[A-Za-z0-9+/=]{12,}/i, // H5, short spelling
  new RegExp(String.raw`(?:${RUNNER})\s+(?:-\w+\s+)*-c\s+["']?\s*[$\`]`, "m"), // H6 code from an expansion
  /(?:source|\.)\s+<\(|<\(\s*(?:curl|wget)\b|\$\(\s*(?:curl|wget)\b/, // H6 code from a download
  new RegExp(String.raw`${AT}["']?(?:\$(?:[({]|[\w@*#?!-])|\`)`, "m"), // H7 a dynamic command word
  new RegExp(String.raw`${AT}[^\s;&|()<>'"=]*[*?][^\s;&|()<>]*(?=\s|$)`, "m"), // H9 a glob command word
];

/** H8: a file this text writes (`>`, `>>`, `tee`) that the text then runs, sources or makes executable. */
function runsWhatItWrites(text: string): boolean {
  const written = new Set<string>();
  for (const match of text.matchAll(/(?:\d?>>?|\btee(?:\s+-a)?)\s*(["']?)([^\s;&|"'<>]+)\1/g)) written.add(match[2]!);
  for (const path of written) {
    if (path === "/dev/null" || /^&?\d$/.test(path)) continue;
    const name = path.split("/").pop()!;
    const esc = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const spelled = `(?:["']?(?:[^\\s;&|"']*/)?${esc(name)}["']?)`;
    if (new RegExp(String.raw`(?:${RUNNER}|source|chmod\s+[+\w]*x|\.)\s+(?:-\S+\s+)*${spelled}(?=[\s;&|)]|$)`, "m").test(text)) return true;
    // the written file as a command word (`./run.sh`, `/tmp/x.sh`)
    if (new RegExp(String.raw`${AT}["']?(?:[^\s;&|"']*/)?${esc(name)}["']?(?=[\s;&|)]|$)`, "m").test(text)) return true;
  }
  return false;
}

/** The first hard category the whole text reads as, or null when it reads clear. */
export function unreadableHardRead(text: string): UnreadableHold | null {
  if (typeof text !== "string" || text.length > MAX_TEXT) return "hiding";
  if (looksSensitive(text)) return "sensitive";
  if (looksDestructive(text)) return "destructive";
  if (HIDING.some((re) => re.test(text)) || runsWhatItWrites(text)) return "hiding";
  return null;
}
