// Auto mode: when a bot may answer its own permission requests.
//
// Two ways in — the bot is in auto mode, or the user pressed "Always
// allow" for that one tool — and one way out: anything that reads as
// destructive stops and asks a human anyway.
//
// The guard is deliberately tiny and literal. It is NOT a security
// boundary (an agent set on damage has a thousand spellings for `rm`);
// it is a "you probably didn't mean to hand THIS one over unattended"
// backstop for the obvious catastrophes. Real containment is the
// sandbox and the bot's own computer, not a regex.

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf, rm -fr, rm -r -f
  /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+[^|]*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb
  /\bgit\s+push\s+[^|]*--force(-with-lease)?\b|\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i,
  /\bsudo\s+rm\b|\bchmod\s+-R\s+777\s+\//i,
];

export function looksDestructive(text: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(text));
}

export interface AutoApprover {
  autoApprove?: boolean;
  alwaysAllow?: string[];
}

/** Why this request may be answered without the human, or null to ask.
 * The returned string becomes the chip in the transcript, so an
 * auto-approved action is never invisible. */
export function autoDecision(bot: AutoApprover, tool: string, summary: string): string | null {
  if (looksDestructive(summary) || looksDestructive(tool)) return null;
  if (bot.alwaysAllow?.includes(tool)) return `auto-approved ${tool} (always allowed)`;
  if (bot.autoApprove) return `auto-approved ${tool}`;
  return null;
}
