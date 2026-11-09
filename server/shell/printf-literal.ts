// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NL-SAMETURN-1018 5 (designs/NL-SAMETURN-SCRIPT-1018.md r2): the ONE decoder both sides use for the same-text script form
// `printf '<literal>' > F && bash F`. The approval walk (shell/walk.ts outputOf) and the outside scan (outside-scan.ts) must
// read the same bytes printf writes, so neither has its own reading.

/** The simple printf format escapes, decoded exactly as printf does. */
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n", t: "\t", "\\": "\\", '"': '"', a: "\u0007", b: "\b", f: "\f", r: "\r", v: "\v",
};

/** The bytes `printf <format>` writes when the format (the shell's word after quote removal, expansion-free) holds only
 *  plain characters, the simple escapes `\n \t \\ \" \a \b \f \r \v` and `%%`. Any other `\` sequence (`\0`, octal, `\x`,
 *  `\u`, `\e`, `\c`, a trailing `\`), any other `%` (a directive, which would read operands), or a format that printf would
 *  take as an option (a leading `-`) is not decoded: null, and the caller keeps today's value reading. */
export function decodePrintfLiteral(format: string): string | null {
  if (format.startsWith("-")) return null;
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const c = format[i]!;
    if (c === "%") {
      if (format[i + 1] !== "%") return null;
      out += "%";
      i++;
      continue;
    }
    if (c === "\\") {
      const next = format[i + 1];
      const decoded = next === undefined ? undefined : SIMPLE_ESCAPES[next];
      if (decoded === undefined) return null;
      out += decoded;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** NL-OPUS r3 A2: the ONE matcher for the same-text contract, `printf '<literal>' > F && (bash|sh) F` on one line: one single-quoted
 *  format, `>` only, an unconditional `&&`, the same plain F (no `..` segment, no leading `-`), nothing before, between or after.
 *  `body` is the format decoded above; `stripped` is the text with the literal replaced by `''` (the scan reads it as today with
 *  exactly the two F rules suppressed). Null: the text is anything else, or the format does not decode (today's reading). */
const SAME_TEXT_RE = /^[ \t]*(?:cd[ \t]+(?:"(\/[^"\\$`]*|[A-Za-z]:\/[^"\\$`]*)"|(\/[^\s;&|<>()'"`$\\]*|[A-Za-z]:\/[^\s;&|<>()'"`$\\]*))[ \t]*&&[ \t]*)?(printf[ \t]+'([^'\r\n]*)'[ \t]*>[ \t]*([A-Za-z0-9_][A-Za-z0-9_./-]*)[ \t]*&&[ \t]*(bash|sh)[ \t]+([A-Za-z0-9_][A-Za-z0-9_./-]*)[ \t]*)$/;
/** r4 R4-6: ONE optional leading `cd <absolute folder> &&` (quoted or not, forward slashes, no variable, no other command, `;` or `||`)
 *  is part of the contract only when `sameFolder` says the folder IS the command's folder (canonical native realpaths, compared
 *  exactly). The cd is then a no-op and is dropped from `stripped`; F resolves against the command's folder. Any other cd (relative,
 *  another folder, `-`, flags, two of them) or no `sameFolder`: null, today's reading. */
export function printfRunContract(text: string, sameFolder?: (folder: string) => boolean): { body: string; file: string; shell: string; stripped: string } | null {
  const m = SAME_TEXT_RE.exec(text);
  if (!m || m[5] !== m[7] || /(?:^|\/)\.\.(?:\/|$)/.test(m[5]!)) return null;
  const folder = m[1] ?? m[2];
  if (folder !== undefined && (sameFolder === undefined || !sameFolder(folder))) return null;
  const body = decodePrintfLiteral(m[4]!);
  return body === null ? null : { body, file: m[5]!, shell: m[6]!, stripped: m[3]!.replace(`'${m[4]!}'`, "''") };
}
