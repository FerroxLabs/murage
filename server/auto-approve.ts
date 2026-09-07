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

// Not destructive, but exactly what you don't hand over unattended: a
// bot reading your keys is quiet, permanent, and unrecoverable.
const SENSITIVE = [
  /(^|[\s/"'])\.env(\.|$|["'\s])/i,
  /\.ssh\/|id_rsa|id_ed25519|authorized_keys/i,
  /\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json/i,
  /security\s+find-(generic|internet)-password|\bkeychain\b/i,
  /\bcredentials?\.json\b|\bserviceaccount\b/i,
];

/** First matching pattern's source, so a verdict can NAME the rule that
 * made it — the decision log's whole value is "which rule", and deriving
 * the match a second time at the call site is how the log and the verdict
 * drift apart. */
function matchFirst(rules: RegExp[], text: string): string | null {
  for (const re of rules) if (re.test(text)) return re.source;
  return null;
}

export function looksSensitive(text: string): boolean {
  return matchFirst(SENSITIVE, text) !== null;
}

export function looksDestructive(text: string): boolean {
  return matchFirst(DESTRUCTIVE, text) !== null;
}

/** The key an "Always allow" remembers.
 *
 * A bare tool name is far too coarse for a command runner: remembering
 * "Bash" would hand the bot a permanent unattended shell, which is the
 * opposite of what someone pressing "always allow" on `git status`
 * intends. Simple literal commands are keyed by their program —
 * `Bash:git`, `Bash:npm`. Complex shell syntax has no remembered key;
 * undefined also hides the client's "Always allow" action. Computed once,
 * server-side, so the display and the grant cannot disagree.
 *
 * This narrows remembered permission, not execution: program arguments,
 * config, PATH and env can still change what a program does. Containment
 * remains the sandbox's job, and explicit Auto mode is unchanged. */
const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "exec_command", "run_command", "computer_exec", "terminal"]);

// A grant to one of these is effectively a grant to a command interpreter
// or another dispatcher. Do not infer the wrapped program from its arguments.
const COMMAND_DISPATCHERS = /^(?:sh|bash|zsh|fish|dash|ksh|csh|tcsh|ash|pwsh|powershell|cmd|python(?:\d+(?:\.\d+)*)?|node|nodejs|perl|ruby|php|lua(?:\d+(?:\.\d+)*)?|deno|bun|osascript|eval|exec|source|\.|env|command|builtin|xargs|time|timeout|nohup|nice|doas|su|if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|coproc)$/i;

/** Recognize only a literal simple-command subset of POSIX shell syntax.
 * Quotes may contain literal operators, but expansion, escaping, redirects,
 * comments and control syntax fail closed. This is deliberately not a shell
 * parser: unsupported forms must ask instead of sharing a first-word grant. */
function simpleProgram(summary: string): string | undefined {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(summary)) return undefined;
  // Generic shell tools do not identify their dialect. Windows expands %
  // and ! and uses ^ for escaping, including forms POSIX quotes would hide.
  // Unsupported syntax asks even when those characters might be literal.
  if (/[%^!]/.test(summary)) return undefined;
  const words: { value: string; assignment: boolean }[] = [];
  let i = 0;
  while (i < summary.length) {
    if (summary[i] === " " || summary[i] === "\t") {
      i += 1;
      continue;
    }
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(summary.slice(i));
    let value = "";
    let quote: "'" | '"' | undefined;
    while (i < summary.length) {
      const ch = summary[i];
      if (quote) {
        if (ch === quote) quote = undefined;
        else {
          if (quote === '"' && /[$`\\]/.test(ch)) return undefined;
          value += ch;
        }
      } else if (ch === " " || ch === "\t") {
        break;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else {
        if (/[;&|<>()[\]{}$`\\*?~#!]/.test(ch)) return undefined;
        value += ch;
      }
      i += 1;
    }
    if (quote) return undefined;
    words.push({ value, assignment });
  }
  let next = 0;
  // Preserve existing literal assignment / bare sudo grants, but sudo
  // options (which take arguments) are unsupported rather than guessed at.
  while (next < words.length && (words[next].assignment || words[next].value === "sudo")) next += 1;
  const executable = words[next]?.value;
  if (!executable || !/^[A-Za-z0-9_./][A-Za-z0-9_./-]*$/.test(executable)) return undefined;
  const program = executable.split("/").pop();
  if (!program) return undefined;
  // Windows executable/script suffixes must not turn a known dispatcher
  // into a per-program grant. Keep ordinary keys (e.g. git.exe) unchanged.
  const dispatcher = program.replace(/\.(?:exe|com|cmd|bat)$/i, "");
  if (COMMAND_DISPATCHERS.test(dispatcher) || dispatcher.toLowerCase() === "sudo") return undefined;
  return program;
}

export function approvalKey(tool: string, summary: string, scope?: "local-computer"): string | undefined {
  const bare = tool.toLowerCase().replace(/^mcp__.+__/, "").split(".").pop()!;
  if (!COMMAND_TOOLS.has(bare)) return scope ? `${scope}:${tool}` : tool;
  const program = simpleProgram(summary);
  if (!program) return undefined;
  const key = `${tool}:${program}`;
  return scope ? `${scope}:${key}` : key;
}

export interface AutoApprover {
  autoApprove?: boolean;
  alwaysAllow?: string[];
}

/** Why a verdict landed the way it did. `unattended-block` exists only in
 * contrast: a grant WOULD have fired, and the only thing that stopped it
 * was that nobody started this turn — the most audit-worthy card of all. */
export type AutoVerdictSource =
  | "always-allow"
  | "auto-mode"
  | "unattended-block"
  | "local-computer-block"
  | "destructive-guard"
  | "sensitive-guard"
  | "no-grant";

export interface AutoVerdict {
  /** Chip text when the bot may answer itself, null when a human decides.
   * The string becomes the chip in the transcript, so an auto-approved
   * action is never invisible. */
  approve: string | null;
  source: AutoVerdictSource;
  /** What identifies the rule that decided: the matched regex (guards) or
   * the granted key (always-allow, and unattended-block over one). Auto
   * mode has no narrower identity than the mode itself, so it carries none. */
  rule?: string;
}

/** Presentation only. A held card names the actual guard, never changes it. */
export function approvalHoldNote(verdict: AutoVerdict | null | undefined): string | undefined {
  if (!verdict || verdict.approve) return undefined;
  switch (verdict.source) {
    case "destructive-guard": return "This action may be destructive. Review it before allowing it.";
    case "sensitive-guard": return "This action may access sensitive data. Review it before allowing it.";
    case "unattended-block": return "This task started outside the desktop. Your approval is required before this action can continue.";
    case "local-computer-block": return "This action controls your computer. Your approval is required.";
    default: return undefined;
  }
}

/** The verdict AND its provenance. The decision itself is unchanged from
 * autoDecision below — this exists so the decision log can record which
 * rule decided without the call site re-deriving (and eventually
 * mis-deriving) the match. */
export function autoVerdict(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
  },
): AutoVerdict {
  // the guards outrank the grants, so an "always allow" can never widen
  // into them
  const destructive = matchFirst(DESTRUCTIVE, summary) ?? matchFirst(DESTRUCTIVE, tool);
  const sensitive = destructive ? null : matchFirst(SENSITIVE, summary);
  // The grant is computed even when a hard block will refuse it: the row
  // worth auditing is "this WOULD have auto-approved, and only the block
  // stood in the way", which cannot be told apart from an ordinary
  // "nobody granted this" card without knowing both halves.
  const key = approvalKey(tool, summary, context?.scope);
  const grant =
    destructive || sensitive
      ? null
      : key !== undefined && bot.alwaysAllow?.includes(key)
        ? { approve: `auto-approved ${key} (always allowed)`, source: "always-allow" as const, rule: key }
        : bot.autoApprove
          ? { approve: `auto-approved ${tool}`, source: "auto-mode" as const, rule: undefined }
          : null;
  if (context?.unattended) {
    // Auto mode is something a person switched on for turns they are present
    // for. A webhook turn begins with nobody watching, on a payload someone
    // else wrote, so it does not inherit that decision — the guard above is a
    // pattern list its own comment calls "not a security boundary", and it
    // must not stand in for a human at 3am. A guard that would have carded
    // anyway keeps its own name; the block is only the story when it is the
    // thing that changed the outcome.
    if (grant) return { approve: null, source: "unattended-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (context?.scope === "local-computer" && !bot.autoApprove) {
    // Host control is not covered by a remembered always-allow grant.
    // After the Auto-on-this-computer warning, unclassified GUI actions
    // (click/type) may auto-approve; destructive/sensitive still card.
    if (grant) return { approve: null, source: "local-computer-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
  if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
  if (grant) return { approve: grant.approve, source: grant.source, rule: grant.rule };
  return { approve: null, source: "no-grant" };
}

/** Why this request may be answered without the human, or null to ask. */
export function autoDecision(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
  },
): string | null {
  return autoVerdict(bot, tool, summary, context).approve;
}
