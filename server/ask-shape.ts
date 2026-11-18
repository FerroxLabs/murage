// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NL-ASK19 (1.0.19): a fixed, content-free name for the SHAPE of a command the reader held, for the asked log line only.
// It reads the text to pick a name and returns one of the names below; the text itself is never returned or logged.
// It changes no verdict: it runs after the verdict, on a held `unreadable` ask, and only names it.
export type AskShape =
  | "eval" | "pipe-to-shell" | "sed-i" | "perl-pe" | "export-path" | "env-prefix-script" | "local-script"
  | "var-target" | "interpreter" | "other";

const SCRIPT_RUNNER = "(?:node|deno|bun|python[0-9.]*|ruby|perl|php|lua|bash|sh|zsh|dash|ksh)";
const SHAPES: ReadonlyArray<readonly [AskShape, RegExp]> = [
  ["eval", /(?:^|[;&|(\n]\s*)(?:eval|exec)\s/],
  ["pipe-to-shell", /\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/],
  ["sed-i", /\bsed\b[^|;&\n]*\s-(?:[A-Za-z]*i|-in-place)/],
  ["perl-pe", /\bperl\b\s+-[A-Za-z]*[pni]/],
  ["export-path", /(?:^|[;&|(\n]\s*)(?:export\s+)?(?:PATH|HOME|IFS|LD_[A-Z_]+|DYLD_[A-Z_]+|NODE_OPTIONS|PYTHONPATH|BASH_ENV)=/],
  ["env-prefix-script", new RegExp(`(?:^|[;&|(\\n]\\s*)(?:env\\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)+(?:(?:nohup|time|timeout\\s+\\S+)\\s+)?(?:${SCRIPT_RUNNER}\\s|\\./)`)],
  ["local-script", new RegExp(`(?:^|[;&|(\\n]\\s*)(?:\\./|\\.\\s+\\S|source\\s|(?:nohup\\s+|time\\s+)?${SCRIPT_RUNNER}\\s+[^-\\s]\\S*\\.(?:sh|js|mjs|cjs|ts|py|rb|pl|php|lua)\\b)`)],
  ["var-target", /\b(?:rm|mv|cp|chmod|chown|ln|dd|truncate|shred)\b[^;&|\n]*\$/],
  ["interpreter", /\b(?:node|deno|bun|python[0-9.]*|ruby|perl|php|lua|awk)\s+(?:-[A-Za-z]*[ce]\b|-\s|<<)/],
];

/** One fixed name for what kind of command text this is. Never returns any part of the text. */
export function askShapeOf(text: string | undefined): AskShape {
  if (!text) return "other";
  const head = text.length > 65_536 ? text.slice(0, 65_536) : text;
  for (const [name, re] of SHAPES) if (re.test(head)) return name;
  return "other";
}
