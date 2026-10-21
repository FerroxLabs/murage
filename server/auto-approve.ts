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

import { CONNECTED_APPS_SERVER, sameToolGrant } from "../shared/connected-app-names.ts";
import { actionGrantKey, actionGrantRead, actionGrantSet, commandArgument, placeArgumentScan, resolveCall, type GrantCall } from "../shared/app-action-grant.ts";
import { isStopLineKey, stopFindings, stopLineKey, stopLineKeyCovers, type StopHit } from "./stop-line.ts";
import { redactSecretsInText } from "./redact.ts";
import { alwaysAskCommand, alwaysAskNote, alwaysAskRoutineCommand, type CarvedTarget, unreadableHit, type AlwaysAskHit } from "./always-ask.ts";
import { commandCwdFromToolInput, commandFromToolInput, exactCommandKey, isExactCommandKey, routineExactGrantCovers, type ExactCommand } from "../shared/exact-command.ts";
import { approvalSummaryIsCut } from "../shared/approval-summary.ts";
import { SENSITIVE_RULES } from "../shared/sensitive-paths.ts";
import { globKeyRead } from "../shared/sensitive-globs.ts";
import { powershellRunner } from "./shell/pwsh.ts";
import { requiredFields } from "./drivers/contracts.ts";
import { homedir } from "node:os";
import { realPathInOrder, type PlaceOptions } from "../shared/in-project.ts";
import { isOwnComputerRead, isOwnRead, isOwnUnasked } from "../shared/own-servers.ts";
import { APP_LOOKUPS, ownAppTool } from "../shared/app-action-words.ts";
import { pinOverrideIn, promptVerdict, type PromptFacts } from "../shared/prompt-capable.ts";

/** The plain `rm` rule, the one a delete placed inside the bot's own roots
 * is excused from (see `deletesInside` below). */
const RM_RULE = /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i;
/** Stopping processes stays destructive for that excuse: a command that
 * kills something is guarded whatever else it deletes. */
const KILLS = /\b(pkill|killall|kill)\b/;

/** PowerShell's and cmd's `rm -r`/`rm -f` (1.0.4 F1): Remove-Item under any
 * of its names with `-Recurse` or `-Force` (any prefix PowerShell accepts,
 * typographic dashes included), and cmd's `rd`/`del` with `/s`. Auto cards it
 * as it cards `rm -rf`; a delete placed inside the bot's own roots is excused
 * the same way. */
const PS_RM_RULE = /(?:^|[\s;|&(){}])(?:remove-item|ri|rm|rmdir|rd|del|erase)(?:\.exe)?\s(?:[^;|&\n]*\s)?(?:[-\u2013\u2014\u2015](?:r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?|fo(?:r(?:c(?:e)?)?)?)(?=[\s:;|&)]|$)|\/s(?=[\s;|&)]|$))/i;
/** The delete rules a delete placed inside the bot's own roots is excused from. */
const EXCUSED_RULES: readonly RegExp[] = [RM_RULE, PS_RM_RULE];

const DESTRUCTIVE = [
  RM_RULE, // rm -rf, rm -fr, rm -r -f
  PS_RM_RULE, // Remove-Item -Recurse -Force, ri -r -fo, rd /s
  /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+[^|]*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb
  /\bgit\s+push\s+[^|]*--force(-with-lease)?\b|\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i,
  /\bsudo\s+rm\b|\bchmod\s+-R\s+777\s+\//i,
];

// Not destructive, but exactly what you don't hand over unattended: a
// bot reading your keys is quiet, permanent, and unrecoverable. The list is
// shared/sensitive-paths.ts (Rule 35), the one list every gate imports.
const SENSITIVE = SENSITIVE_RULES;

// Tools that ASK THE OWNER something. These are never permissions, however
// an engine happens to file them: the entire point of the call is that a
// person decides, so a machine answering one — auto mode, a remembered
// grant, or the AI reviewer — is not "approval", it is an invented answer.
// Claude Code's AskUserQuestion arrives through the permission host and was
// auto-approved with no answers at all, which the model reads as "The user
// did not answer the questions."
//
// Identity comes from what the ENGINE reports — Claude's `tool_name`, Codex's
// method, Fuigo's extension method, an ACP tool call's name — never from
// model prose. Unknown spellings fail CLOSED here: an unrecognized name is
// treated as an ordinary permission by the rules below, so this list is
// defense in depth behind each driver's own trusted signal, not the only gate.
const QUESTION_TOOLS = new Set([
  "askuserquestion",
  "askuser",
  "ask_user",
  "ask_user_question",
  "request_user_input",
  "requestuserinput",
  "question",
  "clarify",
  "elicitation",
  // full method identities, which have no useful last segment
  "item/tool/requestuserinput",
  "mcpserver/elicitation/request",
  "elicitation/create",
  "_fuigo/ask_user_question",
  "_fuigo/mcp/elicit",
]);

/** Is this the name of a tool that asks the owner a question?
 *
 * Matches the whole identity and its last segment, so an MCP-namespaced
 * (`mcp__box__ask_user`), dotted (`functions.request_user_input`) or
 * slash-separated method (`_fuigo/ask_user_question`) is recognized as the
 * same tool. */
export function isQuestionTool(tool: string): boolean {
  const bare = tool.trim().toLowerCase().replace(/^mcp__.+__/, "");
  if (QUESTION_TOOLS.has(bare)) return true;
  return QUESTION_TOOLS.has(bare.split(/[./]/).pop() ?? "");
}

/** Is this remembered "always allow" key a grant over a question tool?
 *
 * Older builds offered "Always allow" on a question (the key was the bare
 * tool name, optionally scoped), which would have handed every future
 * question to the machine permanently. Such a key is stripped at load and
 * refused at the grant routes; `autoVerdict` ignores it regardless. */
export function isQuestionGrant(key: string): boolean {
  return isQuestionTool(key.replace(/^local-computer:/, ""));
}

export function withoutQuestionGrants(keys: string[]): string[] {
  return keys.filter((key) => !isQuestionGrant(key));
}

/** Is this remembered key a command tool's bare name (`PowerShell`, `Bash`,
 * `local-computer:PowerShell`)? A command tool's grant is keyed by program
 * (`PowerShell:git`), so a bare one would be a standing shell. 1.0.3 and
 * earlier wrote one for PowerShell, which was not read as a command tool:
 * such a key is dropped at load, refused at the grant routes, and answers
 * nothing in `autoVerdict` regardless. */
export function isBareCommandGrant(key: string): boolean {
  return isCommandTool(key.replace(/^local-computer:/, ""));
}

export function withoutBareCommandGrants(keys: string[]): string[] {
  return keys.filter((key) => !isBareCommandGrant(key));
}

/** First matching pattern's source, so a verdict can NAME the rule that
 * made it — the decision log's whole value is "which rule", and deriving
 * the match a second time at the call site is how the log and the verdict
 * drift apart. */
function matchFirst(rules: readonly RegExp[], text: string): string | null {
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
const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "exec_command", "run_command", "computer_exec", "terminal", "powershell", "pwsh"]);
/** Pi's and Claude Code's (on Windows) PowerShell tool, under any spelling. */
const POWERSHELL_TOOLS = new Set(["powershell", "pwsh"]);

/** PowerShell's runners (launchers, interpreters, keywords and cmdlets that
 * run what they are handed) are ONE list, server/shell/pwsh.ts
 * `powershellRunner`: the always-ask reader asks on the ones it does not
 * model, and none of them gets an "Always allow" key here, so the two cannot
 * drift. A grant to one would be a grant to whatever it is handed. */
// A grant to one of these is effectively a grant to a command interpreter
// or another dispatcher. Do not infer the wrapped program from its arguments.
const COMMAND_DISPATCHERS = /^(?:sh|bash|zsh|fish|dash|ksh|csh|tcsh|ash|pwsh|powershell|cmd|python(?:\d+(?:\.\d+)*)?|node|nodejs|perl|ruby|php|lua(?:\d+(?:\.\d+)*)?|deno|bun|osascript|eval|exec|source|\.|env|command|builtin|xargs|time|timeout|nohup|nice|doas|su|if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|coproc)$/i;

/** Recognize only a literal simple-command subset of POSIX shell syntax.
 * Quotes may contain literal operators, but expansion, escaping, redirects,
 * comments and control syntax fail closed. This is deliberately not a shell
 * parser: unsupported forms must ask instead of sharing a first-word grant. */
function simpleProgram(summary: string, dialect: "posix" | "pwsh" = "posix"): string | undefined {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(summary)) return undefined;
  // PowerShell reads the typographic quotes and dashes as quotes and `-`
  if (dialect === "pwsh" && /[\u2018-\u201E\u2013-\u2015]/.test(summary)) return undefined;
  // Generic shell tools do not identify their dialect. Windows expands %
  // and ! and uses ^ for escaping, including forms POSIX quotes would hide.
  // Unsupported syntax asks even when those characters might be literal.
  if (/[%^!]/.test(summary)) return undefined;
  const words: { value: string; assignment: boolean; quoted: boolean }[] = [];
  let i = 0;
  while (i < summary.length) {
    if (summary[i] === " " || summary[i] === "\t") {
      i += 1;
      continue;
    }
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(summary.slice(i));
    const quoted = summary[i] === "'" || summary[i] === '"';
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
    words.push({ value, assignment, quoted });
  }
  let next = 0;
  // PowerShell has no `NAME=value` prefix (that is a program named so) and
  // no `sudo -n`: the first word is the program, or there is no key.
  // A quoted name (`"cmd" /c …`) is not a call PowerShell makes as written.
  if (dialect === "pwsh" && (words[0]?.assignment || words[0]?.quoted || words[0]?.value.toLowerCase() === "sudo")) return undefined;
  // Literal assignments are looked past. `sudo` only in its non-interactive
  // form (`sudo -n <program>`): a bare `sudo` can ask for the owner's
  // password (Rule 68f, prompt-capable), so a `Bash:<program>` grant never
  // answers it; any other sudo option is unsupported rather than guessed at.
  for (;;) {
    while (next < words.length && words[next].assignment) next += 1;
    if (words[next]?.value !== "sudo") break;
    let after = next + 1;
    while (after < words.length && (words[after].value === "-n" || words[after].value === "--non-interactive")) after += 1;
    if (after === next + 1) return undefined;
    next = after;
  }
  const executable = words[next]?.value;
  if (!executable || !/^[A-Za-z0-9_./][A-Za-z0-9_./-]*$/.test(executable)) return undefined;
  const program = executable.split("/").pop();
  if (!program) return undefined;
  // Windows executable/script suffixes must not turn a known dispatcher
  // into a per-program grant. Keep ordinary keys (e.g. git.exe) unchanged.
  const dispatcher = program.replace(/\.(?:exe|com|cmd|bat)$/i, "");
  if (COMMAND_DISPATCHERS.test(dispatcher) || dispatcher.toLowerCase() === "sudo") return undefined;
  // a launcher, an interpreter or a runner, under either shell (`wsl`,
  // `schtasks`, `py`, `ubuntu2204.exe`): no key
  if (powershellRunner(program) !== undefined) return undefined;
  // a script or a file by path (`./w.ps1`): the reader asks for it, and it
  // gets no key
  if (dialect === "pwsh" && executable.includes("/") && !/\.(exe|com)$/i.test(executable)) return undefined;
  return program;
}

/** Is this one of the tools that runs a shell command? */
export function isCommandTool(tool: string): boolean {
  return COMMAND_TOOLS.has(bareToolName(tool));
}

/** Is this a PowerShell tool? Its command text is PowerShell's, whatever it
 * starts with, and it is read by the PowerShell readers. */
export function isPowerShellTool(tool: string): boolean {
  return POWERSHELL_TOOLS.has(bareToolName(tool));
}

function bareToolName(tool: string): string {
  return tool.toLowerCase().replace(/^mcp__.+__/, "").split(".").pop()!;
}

export function approvalKey(tool: string, summary: string, scope?: "local-computer", call?: GrantCall): string | undefined {
  // No "Always allow" for a question: undefined hides the action entirely.
  if (isQuestionTool(tool)) return undefined;
  // Nor for a call the driver could not report whole: a key read off a cut
  // call names something other than what runs.
  if (call?.truncated) return undefined;
  // A tool whose NAME reads as an exact-command key must not be able to
  // match one by its bare name.
  if (isExactCommandKey(tool)) return undefined;
  // A connected-app call, or a tool named only "other", is remembered by the
  // one action it runs, or not at all (shared/app-action-grant.ts).
  const action = actionGrantKey(tool, call);
  if (action !== undefined) return action === null ? undefined : scope ? `${scope}:${action}` : action;
  if (!isCommandTool(tool)) return scope ? `${scope}:${tool}` : tool;
  const program = simpleProgram(summary, isPowerShellTool(tool) || call?.commandShell === "pwsh" ? "pwsh" : "posix");
  if (!program) return undefined;
  const key = `${tool}:${program}`;
  return scope ? `${scope}:${key}` : key;
}

/** The "Always allow this exact command here" key a card offers, or
 * undefined. Offered only for a command tool the caller has place facts for
 * (the engine's own command text, its folder and the engine), and never for
 * a command the destructive or key guard would card anyway: such a grant
 * could never apply, and a key guard hit may carry a secret that has no
 * business being written into the bot's settings. */
export function exactAllowKeyFor(tool: string, summary: string, exact: ExactCommand | undefined, promptFacts?: PromptFacts): string | undefined {
  if (!exact || isQuestionTool(tool) || !isCommandTool(tool)) return undefined;
  const text = `${summary}\n${exact.command}`;
  if (looksDestructive(text) || looksSensitive(text) || redactSecretsInText(text) !== text) return undefined;
  // nor for a prompt-capable command (Rule 68f): the grant could never apply
  if (promptVerdict(exact.command, promptFacts)) return undefined;
  return exactCommandKey(exact);
}

/** The place facts for an exact-command grant, from the ENGINE's structured
 * tool call (never the card text): its command, the folder it names for this
 * one command or else the turn's folder, and the engine instance asking.
 * Undefined when any of the three is missing or cannot be placed. */
export function exactCommandForRequest(input: {
  tool: string;
  toolCall?: { name: string; input: unknown };
  engine: string | undefined;
  turnCwd: string | undefined;
}): ExactCommand | undefined {
  if (!isCommandTool(input.tool) || isQuestionTool(input.tool)) return undefined;
  const command = commandFromToolInput(input.toolCall?.input);
  const named = commandCwdFromToolInput(input.toolCall?.input);
  if (command === undefined || named === null || !input.engine) return undefined;
  const cwd = named ?? input.turnCwd;
  if (!cwd) return undefined;
  const exact = { engine: input.engine, cwd, command };
  return exactCommandKey(exact) === undefined ? undefined : exact;
}

export interface AutoApprover {
  autoApprove?: boolean;
  /** Full access, the level above Auto. It counts only while `autoApprove`
   * is on too, so every path that switches Auto off ends it as well. */
  fullAccess?: boolean;
  /** Full access also covers the owner's own messages from Telegram, Slack
   * and Discord. Off unless it is exactly `true`. */
  fullAccessChannelMessages?: boolean;
  /** No limits, the level above Full access: no stop line. Counts only
   * while Full access does; the key guard still asks. */
  noLimits?: boolean;
  alwaysAllow?: string[];
}

/** Is this bot (or task) on Full access? */
export function hasFullAccess(bot: AutoApprover | null | undefined): boolean {
  return bot?.autoApprove === true && bot.fullAccess === true;
}

/** Is this bot (or task) on No limits? Only on top of Full access. */
export function hasNoLimits(bot: AutoApprover | null | undefined): boolean {
  return hasFullAccess(bot) && bot?.noLimits === true;
}

/** Who started the turn, as Full access reads it: the owner at the desktop
 * (or a bot the owner's turn reached), the owner's own message from
 * Telegram, Slack or Discord, a scheduled or manual run of one of the owner's
 * routines judged at that routine's own level (server/routine-permissions.ts),
 * or anyone and anything else — a webhook, another person's channel message,
 * a turn whose origin could not be proven. */
export type FullAccessOrigin = "owner" | "owner-channel" | "routine" | "other";

/** Does Full access cover a turn from this origin? The owner's channel
 * messages only when the bot's option says so. A routine run is covered when
 * the level it is judged at is Full access or No limits: the caller has
 * already applied the routine's level to `bot`, so the flags ARE that level.
 * Everything else never. */
export function fullAccessCovers(bot: AutoApprover | null | undefined, origin: FullAccessOrigin): boolean {
  if (!hasFullAccess(bot)) return false;
  if (origin === "owner" || origin === "routine") return true;
  return origin === "owner-channel" && bot?.fullAccessChannelMessages === true;
}

/** Why a verdict landed the way it did. `unattended-block` exists only in
 * contrast: a grant WOULD have fired, and the only thing that stopped it
 * was that nobody started this turn — the most audit-worthy card of all. */
export type AutoVerdictSource =
  /** One of the few commands that always ask, at every level, No limits
   * included: deleting the drive, the home folder or a system folder,
   * erasing a disk, or a fork bomb (server/always-ask.ts). It still asks;
   * it is never blocked, and no standing grant answers it. */
  | "always-ask"
  /** Rule 72: a narrowing denial. Nothing runs and no card is raised; the
   * driver hands the engine `note` as the reason so it can rewrite the call.
   * The same (tool, text) denied NARROW_DENIALS_BEFORE_CARD times in one turn
   * raises the card instead (server/narrow-denials.ts). */
  | "narrow"
  | "always-allow"
  /** "Always allow this exact command here": the same command text, folder
   * and engine the owner allowed (shared/exact-command.ts). */
  | "exact-command"
  | "auto-mode"
  | "full-access"
  /** No limits: Full access without the stop line (the key guard holds). */
  | "no-limits"
  /** The bot writing inside its OWN managed workspace or thread
   * folder. Not a grant and not a mode — the action was never the person's
   * to authorize (see the comment on `ownWorkspace` below). */
  | "own-workspace"
  /** The bot reading back its OWN saved tool result: a read-only command or
   * read tool on a file in this session's own result folder
   * (server/own-tool-results.ts). Not a grant and not a mode. */
  | "own-tool-results"
  | "project-work-roots"
  /** One of Murage's own tools that runs unasked on Claude and Codex
   * (shared/own-servers.ts OWN_UNASKED), asked for by an ACP engine whose
   * dispatcher files every MCP call as a permission. A read (OWN_READS, or a
   * connected-app lookup) is answered at every level, Ask included; any other
   * row whenever the bot is at Auto, on every turn, unattended ones (a
   * routine, a webhook, a channel event) included, as Claude and Codex run
   * them. Only when the grant gate proved the call runs on one of
   * this turn's own mounts. Its activity row already names it, so it adds no chip. */
  | "own-unasked"
  /** The stop line (server/stop-line.ts): deleting outside its folder,
   * paying, or messaging someone new. Full access stops here too. */
  | "stop-line"
  /** The owner allowed this kind of action in this place for the task, from
   * the card's "Allow for this task" or by saying so in chat. */
  | "task-allowance"
  /** "Always allow for this routine": an exact command or a stop-line place
   * the owner allowed for one routine's runs (server/routine-permissions.ts). */
  | "routine-allow"
  | "unattended-block"
  | "local-computer-block"
  | "destructive-guard"
  | "sensitive-guard"
  /** The call could not be read whole (the driver cut the input, a scan
   * ran past its budget, the tool it runs cannot be proven): held at every
   * level, No limits included, like a key-file read. */
  | "unread-call"
  /** Rule 68f, row kind "prompt-capable": a command that can ask for input
   * (a password, a passphrase, a terminal, a new window) and does not carry
   * its non-interactive form. `rule` names the row, `note` its reason.
   * Ahead of every standing answer; Full access and No limits keep theirs. */
  | "prompt-guard"
  | "question-tool"
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
  /** Plain words for the held card: what the bot is about to do and why it
   * stopped (the stop line's `what`). */
  note?: string;
  /** Set only on an approval of a scheduled or manual routine run's command
   * that went through under the routine carve-out: a write or delete whose
   * target is held in a value: each tool and target expression it passed
   * over, never the command's other arguments. The run records them in its
   * history (server/routine-permissions.ts routineValueTargetLine). */
  valueTarget?: CarvedTarget[];
}

/** U20 (Rule 74d) in plain words; the cause follows. */
const U20_WORDS = "Murage could not check the shell environment";
/** No hand known: every per-command value of a pinned name differs from it. */
const NO_PINS: ReadonlyMap<string, string> = new Map();
/** U19 (Rule 68f case 1) in plain words; pinOverride's reason follows. */
const U19_WORDS = "This command changes a setting Murage fixes so engines never ask for input";

/** Presentation only. A held card names the actual guard, never changes it. */
export function approvalHoldNote(verdict: AutoVerdict | null | undefined): string | undefined {
  if (!verdict || verdict.approve) return undefined;
  switch (verdict.source) {
    case "always-ask": return verdict.note;
    case "stop-line": return verdict.note ?? "This action deletes, pays or messages someone new. Review it before allowing it.";
    case "destructive-guard": return "This action may be destructive. Review it before allowing it.";
    case "sensitive-guard": return "This action may access sensitive data. Review it before allowing it.";
    case "unread-call": return verdict.rule?.startsWith(U20_WORDS) || verdict.rule?.startsWith(U19_WORDS) ? `${verdict.rule}. Review it before allowing it.` : "Murage could not read this action whole. Review it before allowing it.";
    case "prompt-guard": return verdict.note ?? "This command can ask for input that nobody would see. Review it before allowing it.";
    case "unattended-block": return "This task started outside the desktop. Your approval is required before this action can continue.";
    case "local-computer-block": return "This action controls your computer. Your approval is required.";
    case "question-tool": return "Your bot is asking you a question. Only you can answer it.";
    default: return undefined;
  }
}

/** The verdict AND its provenance. The decision itself is unchanged from
 * autoDecision below — this exists so the decision log can record which
 * rule decided without the call site re-deriving (and eventually
 * mis-deriving) the match. */
export interface AutoContext {
  /** the engine's whole command, uncapped, for the always-ask reader (the
   * 4,000-character `exactCommand` copy exists for the exact grant, which
   * must stay bounded; a catastrophe after the cut must still be read) */
  commandText?: string;
  /** the folder the engine says `commandText` runs in, when it names one */
  commandCwd?: string;
  /** Where the paths this call names really are, links followed
   * (`realKeyPaths`): the key guard reads them, so a harmless name that links
   * to a key file is held as that file (1.0.4, 09-1). */
  realPaths?: readonly string[];
  /** A path this call names could not be followed to where it lands
   * (`realKeyPaths` cannot): the key guard holds it as a key read. */
  realPathCannot?: string;
  /** The engine's own gate already held this call as a key file (Pi's gate,
   * which resolves links itself): the rule it named. The key guard keeps
   * that verdict at every level; it can only add a hold, never clear one. */
  localHold?: string;
  /** the card's tool input or summary was cut, so the owner cannot see all
   * of it (server/approval-text.ts approvalIsCut); no routine carve-out then */
  inputCut?: boolean;
  /** The caller found the live scheduled or manual routine run that owns
   * this conversation, and records in that run's history any command the
   * routine carve-out lets through (`AutoVerdict.valueTarget`). Honoured only
   * with `routineLevel`; a peer bot's turn for a routine never sets it. */
  routineCarveOut?: boolean;
  /** U20 (Rule 74d): the F12 record says the environment check failed, with this cause. The command is unread: held
   *  with the cause at every level, as any call that could not be read whole. */
  envUnread?: string;
  /** the turn was started by an outside event, with nobody at the keyboard */
  unattended?: boolean;
  /** the request controls the user's active desktop */
  scope?: "local-computer";
  /** the driver's trusted signal that this ask is a question to the owner
   * even though it is filed as a permission (Pi `select`, whose title is
   * extension-composed text and so cannot be matched by name) */
  question?: boolean;
  /** the turn belongs to a routine run (scheduled, manual, webhook or
   * channel trigger) rather than to someone typing to the bot */
  automated?: boolean;
  /** the turn is the workspace owner's own Telegram, Slack or Discord
   * message (it is also unattended and automated) */
  channelOwner?: boolean;
  /** The turn is a scheduled or manual run of one of the owner's routines,
   * and the caller judged `bot` at that routine's level (its own, or the
   * bot's level when the run started). Full access and No limits then cover
   * it exactly as they cover a turn the owner started. Never set for a
   * webhook or channel turn, and an `unattended` mark outranks it. */
  routineLevel?: boolean;
  /** The routine's own "Always allow for this routine" grants: exact-command,
   * stop-line, exact connected-app action and lookup keys (AMEND-13 Rule 76).
   * Honoured only with `routineLevel`, never on an unattended turn or for
   * host control, and never over a guard. */
  routineAllow?: readonly string[];
  /** AMEND-13 Rule 79b: the stop findings each row of an own-connector
   * execute call produced, in call order (server/stop-line.ts
   * classifyAskRows). Read only for a call of two or more rows whose
   * findings agree with `stopLine`; a one-row call keeps r10's outcome. */
  stopRows?: ReadonlyArray<readonly StopHit[]>;
  /** Every task allowance the owner gave this task, so each row's findings
   * are covered one by one (Rule 79b ii). Honoured only on a turn the owner
   * is at, never for host control. */
  taskAllowanceKeys?: readonly string[];
  /** The caller established with the stop line's own reader
   * (server/stop-line.ts deletesPlacedInside) that every delete this command
   * names lands strictly inside the bot's own roots: its workspace and thread
   * folders, the turn's folder, the temp folders. Such a delete is not
   * "destructive" for Auto's guard, unless the command also stops processes
   * or trips any other destructive rule. */
  deletesInside?: boolean;
  /** The caller established — from the engine's STRUCTURED tool
   * input, never from the card text — that every filesystem path this
   * request names lies inside the directories Murage manages for THIS bot:
   * its own workspace folder and its own thread folder under the data dir.
   * The fact is decided in server/own-workspace-approval.ts, which is where
   * the boundary (real paths, segment comparison, `..`, symlinks, another
   * bot's folder) lives; this flag only places it in the order below.
   *
   * Why it is not a permission at all: Murage creates those folders, tells
   * the bot where they are, and shows them in Memory and Files. A bot
   * writing there is the product doing its own bookkeeping, not an action
   * taken on the person's behalf. Before this, one question to a bot in Ask
   * mode raised a card for its own MEMORY.md and another for its own thread
   * file, and an unattended routine simply stopped until someone woke up. */
  ownWorkspace?: boolean;
  /** The bot reading back its own saved tool result. Decided in
   * server/own-tool-results.ts (the session's own folder, a strictly
   * read-only command, every path inside); placed here like `ownWorkspace`:
   * behind the guards, ahead of the unattended and host blocks, because an
   * engine reading what it was just given is not something a person grants. */
  ownToolResults?: boolean;
  projectWorkRoots?: boolean;
  /** What the stop line (server/stop-line.ts) found, computed by the caller
   * from the engine's structured input and the bot's own folders and
   * recipients. `null` = checked, nothing crosses it; `undefined` = not
   * checked (a caller with no place facts), which leaves every rule below
   * exactly as it was. */
  stopLine?: StopHit | null;
  /** The command as the engine reported it, the folder it runs in and the
   * engine asking, for "Always allow this exact command here". The guards
   * read this command too, so a card text cut short cannot hide a match. */
  exactCommand?: ExactCommand;
  /** The task allowance that covers `stopLine`, when the caller holds one:
   * the owner pressed "Allow for this task" or said so in chat. Honoured
   * only on a turn the owner is at. */
  stopAllowedForTask?: string;
  /** The engine's own call, kind and identity, so a remembered grant is
   * matched by the one action it names (shared/app-action-grant.ts). */
  call?: GrantCall;
  /** What the prompt-capable git rows read (Rule 68f): the folder the
   * command runs in (the exact-command cwd, else the turn's) and the HOME
   * handed to the engine. Missing, only the git rows hold. */
  promptFacts?: PromptFacts;
  /** The requesting engine's handed pin map (Rule 74c): a per-command value other than its pin is U19 (Rule 68f case 1).
   *  Missing, no pin is known, so a command that sets any pinned name is U19. */
  handedPins?: ReadonlyMap<string, string>;
}

/** Is the only destructive thing here an `rm` the caller placed inside the
 * bot's own roots? Every other rule, and any process kill, still counts. */
function excusedDelete(text: string, context: AutoContext | undefined): boolean {
  if (context?.deletesInside !== true || KILLS.test(text)) return false;
  return DESTRUCTIVE.every((rule) => EXCUSED_RULES.includes(rule) || !rule.test(text));
}

/** The standing answer a grant or Auto mode would give, before any block:
 * a routine's exact grant, the exact-command grant, the program grant, Auto
 * mode, or null. */
function standingGrant(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context: AutoContext | undefined,
  routineGrants: readonly string[],
  coveredRows: ReadonlySet<number> = new Set(),
): { approve: string; source: "routine-allow" | "exact-command" | "always-allow" | "auto-mode"; rule: string | undefined } | null {
  // AMEND-13 Rules 78, 79a: a connected-app call is answered by standing
  // grants only when EVERY action key matches an applicable grant (a row whose
  // own stop findings were all covered is already authorized, Rule 79b ii).
  // One match, a prefix or `some(...)` is never enough. Auto mode below still
  // authorizes the whole call on its own terms.
  const set = context?.call?.truncated ? null : actionGrantSet(tool, context?.call);
  if (set !== undefined) {
    const appGrant = set ? appSetGrant(bot, set, context?.scope, routineGrants, coveredRows) : null;
    if (appGrant) return appGrant;
    return bot.autoApprove ? { approve: `auto-approved ${tool}`, source: "auto-mode", rule: undefined } : null;
  }
  const key = approvalKey(tool, summary, context?.scope, context?.call);
  // The exact grant is the narrower one, so it names itself first. It is
  // never computed for a host-control request or a non-command tool.
  const exactKey = context?.exactCommand && !context.scope && isCommandTool(tool) && !isQuestionTool(tool)
    ? exactCommandKey(context.exactCommand)
    : undefined;
  // A routine's grant requires the same normalized command, including dates
  // and times, on the same engine in the same folder.
  const routineExact = exactKey !== undefined && context?.exactCommand
    ? routineGrants.find((granted) => routineExactGrantCovers(granted, context.exactCommand!))
    : undefined;
  return routineExact !== undefined
    ? { approve: `auto-approved this command (always allowed for this routine)`, source: "routine-allow", rule: routineExact }
    : exactKey !== undefined && bot.alwaysAllow?.includes(exactKey)
      ? { approve: `auto-approved this exact command (always allowed here)`, source: "exact-command", rule: exactKey }
    // a connected-app grant saved under an earlier release's tool name still covers the tool (shared/connected-app-names.ts)
    : key !== undefined && bot.alwaysAllow?.some((held) => sameToolGrant(held, key))
      ? { approve: `auto-approved ${key} (always allowed)`, source: "always-allow", rule: key }
      : bot.autoApprove
        ? { approve: `auto-approved ${tool}`, source: "auto-mode", rule: undefined }
        : null;
}

/** Rules 78, 79a: the standing answer for a connected-app grant set. Each
 * row (or, for a lookup or custom tool, the one key) must match a routine
 * grant (already limited to an attended routine run off host scope) or one
 * of the bot's own keys. Records the complete matching set and its sources. */
function appSetGrant(
  bot: AutoApprover,
  set: { keys: readonly string[]; rows: ReadonlyArray<{ key: string }> },
  scope: "local-computer" | undefined,
  routineGrants: readonly string[],
  coveredRows: ReadonlySet<number>,
): { approve: string; source: "routine-allow" | "always-allow"; rule: string } | null {
  const scoped = (key: string) => (scope ? `${scope}:${key}` : key);
  const needed = set.rows.length ? set.rows.filter((_, index) => !coveredRows.has(index)).map((row) => row.key) : [...set.keys];
  if (!needed.length) return null;
  const sources: string[] = [];
  let routine = false;
  let own = false;
  for (const key of new Set(needed)) {
    // Rule 80c: no routine grant ever answers a host-scoped ask
    if (!scope && routineGrants.includes(key)) { routine = true; sources.push(`${key} (routine)`); continue; }
    const held = scoped(key);
    if (bot.alwaysAllow?.some((granted) => sameToolGrant(granted, held))) { own = true; sources.push(held); continue; }
    return null;
  }
  const rule = sources.join(" ");
  return routine && !own
    ? { approve: `auto-approved ${needed.length > 1 ? "these actions" : "this action"} (always allowed for this routine)`, source: "routine-allow", rule }
    : { approve: `auto-approved ${rule} (always allowed)`, source: "always-allow", rule };
}

/** Rule 79b: how one stop finding is covered, if it is: the owner's task
 * allowance, the routine's stop key or the bot's always-allow stop key,
 * each under Rule 19's attended and host conditions. A finding with no
 * place is never covered. */
function findingCover(
  bot: AutoApprover,
  hit: StopHit,
  context: AutoContext | undefined,
  routineGrants: readonly string[],
): { source: "task-allowance" | "routine-allow" | "always-allow" | "unattended-block"; key: string } | null {
  if (stopLineKey(hit) === undefined || context?.scope === "local-computer") return null;
  const attended = !context?.unattended && !context?.automated;
  const task = attended ? context?.taskAllowanceKeys?.find((key) => stopLineKeyCovers(key, hit)) : undefined;
  if (task) return { source: "task-allowance", key: task };
  const routine = routineGrants.find((key) => isStopLineKey(key) && stopLineKeyCovers(key, hit));
  if (routine) return { source: "routine-allow", key: routine };
  const granted = bot.alwaysAllow?.find((key) => isStopLineKey(key) && stopLineKeyCovers(key, hit));
  if (granted) return { source: context?.unattended ? "unattended-block" : "always-allow", key: granted };
  return null;
}

export function autoVerdict(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: AutoContext,
): AutoVerdict {
  // A question outranks everything, including the unattended and host
  // blocks: no mode, grant or turn origin lets the machine answer it. It
  // names no rule — no grant was consulted, and none could apply.
  if (context?.question || isQuestionTool(tool)) return { approve: null, source: "question-tool" };
  // Next, and ahead of every mode, grant and allowance: the short list of
  // commands that wipe the computer always asks the owner. No limits lifts the
  // stop line, not this. It reads the engine's own command, whole, when there
  // is one, from the folder the engine says it runs in. With only the card
  // text to go on, a command tool's cut summary asks (the catastrophe may sit
  // after the cut), and a non-command tool's summary is read as text, where
  // an apostrophe in a file name is not an unterminated quote.
  const commandTool = isCommandTool(tool);
  // a PowerShell tool's text is PowerShell's, however it starts, and so is
  // the text of a command tool whose driver runs it under PowerShell (Codex
  // and every ACP engine on Windows, `powershell.exe -Command`)
  const shell = isPowerShellTool(tool) || (commandTool && context?.call?.commandShell === "pwsh") ? "pwsh" : undefined;
  const text = context?.commandText ?? context?.exactCommand?.command;
  const cwd = context?.commandCwd ?? context?.exactCommand?.cwd;
  // The owner's routine carve-out (1.0.3): on a scheduled or manual routine
  // run, with the engine's own whole command in hand, a write or delete whose
  // target is held in a value does not hold the turn. Everything else the
  // reader finds, and every guard below, holds exactly as for any turn. A
  // webhook, a channel event, host control and the owner's own turns never
  // get here.
  const routineCarve = commandTool && text !== undefined && context?.routineLevel === true && context.routineCarveOut === true && !context.unattended && context.inputCut !== true && context.scope === undefined;
  let catastrophe: AlwaysAskHit | null;
  let valueTarget: CarvedTarget[] | undefined;
  if (routineCarve) {
    ({ hit: catastrophe, valueTarget } = alwaysAskRoutineCommand(text, cwd, shell));
  } else {
    catastrophe = text !== undefined
      ? alwaysAskCommand(text, cwd, "command", shell)
      : commandTool && approvalSummaryIsCut(summary)
        ? unreadableHit()
        : alwaysAskCommand(summary, cwd, commandTool ? "command" : "text", shell);
  }
  if (catastrophe) return { approve: null, source: "always-ask", rule: catastrophe.rule, note: alwaysAskNote(catastrophe) };
  // a carved command is guarded on its whole text too, so a key or a
  // destructive step past the card's cut summary still holds
  const verdict = verdictPastAlwaysAsk(bot, tool, summary, context, valueTarget !== undefined ? text : undefined);
  return valueTarget !== undefined && verdict.approve ? { ...verdict, valueTarget } : verdict;
}

/** Every mode, grant and guard after the always-ask reader. */
function verdictPastAlwaysAsk(bot: AutoApprover, tool: string, summary: string, context: AutoContext | undefined, wholeText?: string): AutoVerdict {
  // Full access raises almost no card — not the destructive guard, not the
  // host-control guard — for a turn the owner started. It still stops at the
  // stop line and the key guard (below). A turn started by a webhook, a
  // channel event or a routine carries input someone else wrote (or nobody is
  // watching it), so it is judged exactly as Auto would judge it. The owner's
  // own channel message joins the owner's turns only when the bot's option
  // says so.
  const origin: FullAccessOrigin = context?.unattended || context?.automated
    ? context.channelOwner === true ? "owner-channel"
      : context.routineLevel === true && !context.unattended ? "routine" : "other"
    : "owner";
  // The guards outrank the grants, so an "always allow" can never widen
  // into them. They read the card text, the engine's own command, and the
  // shell line the call's arguments carry under any tool name: a terminal
  // command inside a wrapper or an MCP tool is judged like the engine's own
  // shell tool asking (Astra r3).
  const resolved = resolveCall(context?.call);
  const innerCommand = commandArgument(resolved.kind === "engine" || resolved.kind === "mcp" ? resolved.input : context?.call?.toolCall?.input);
  const guarded = [summary, context?.exactCommand?.command, innerCommand, wholeText].filter((part): part is string => part !== undefined).join("\n");
  const destructive = excusedDelete(guarded, context) ? null : matchFirst(DESTRUCTIVE, guarded) ?? matchFirst(DESTRUCTIVE, tool);
  // The key guard also reads every string the engine's structured arguments
  // carry, wherever it sits: a card title can be neutral. A call it could not
  // read whole (the driver cut the input, or the scan ran past its budget) is
  // held as if it named a key file: the guard never passes what it did not see.
  const scan = placeArgumentScan(context?.call?.toolCall?.input);
  // Rule 55: the driver's contract for this tool, read after resolution and
  // before any guard; a missing or wrong-typed field is unread.
  const contract = requiredFields(context?.call?.engine, resolved, context?.call);
  // A13-FIX-DESIGN C3: the one grant reader; an own-connector call it could
  // not read whole is unread, never a call with "no grant" that a mode answers.
  const grantRead = context?.call?.truncated ? undefined : actionGrantRead(tool, context?.call);
  // Rule 68f case 1 (U19): the command the engine reported, or the shell line its arguments carry, sets a pinned name to
  // anything but the hand's pin, or carries an option that overrides one. Read before every standing answer.
  const commandParts = [context?.exactCommand?.command, innerCommand].filter((part): part is string => part !== undefined);
  const promptText = commandParts.length ? commandParts.join("\n") : isCommandTool(tool) ? summary : undefined;
  const pinUnknown = promptText === undefined ? null : pinOverrideIn(promptText, context?.handedPins ?? NO_PINS);
  const unread = context?.envUnread ? `${U20_WORDS}: ${context.envUnread}`
    : pinUnknown ? `${U19_WORDS}: ${pinUnknown}`
    : context?.call?.truncated ? "the call was cut before it could be checked"
    : scan.cut ? "the call's arguments run past what the key guard reads"
    : resolved.kind === "unproven" ? `the tool this runs cannot be proven: ${resolved.why}`
    : grantRead?.unread ? `Murage could not read every action in this call: ${grantRead.unread}`
    : contract.ok ? null
    : `the call does not carry what this tool needs (${contract.field})`;
  const keyText = [guarded, scan.text, ...(context?.realPaths ?? [])].join("\n");
  const localHold = context?.localHold ? `the engine's own check held this as a key file (${context.localHold})`
    : context?.realPathCannot ? `a path this call names could not be followed to where it lands, so it is held as a key file (${context.realPathCannot.slice(0, 200)})` : null;
  // 09-1: a glob in the command text that could match a key file
  // (`cat ~/.aw?/credentials`, `Get-Content ~\.aws\cred*`) is a read of it
  const commandGlobText = isCommandTool(tool) || commandParts.length || wholeText !== undefined ? [isCommandTool(tool) ? summary : "", ...commandParts, wholeText ?? "", context?.commandText ?? ""].join("\n") : "";
  const keyHit = (): string | null => unread ?? localHold ?? matchFirst(SENSITIVE, keyText) ?? globKeyRead(commandGlobText);
  const sensitive = destructive ? null : keyHit();
  const sensitiveSource: AutoVerdictSource = unread ? "unread-call" : "sensitive-guard";
  // The stop line outranks every mode, Full access included: deleting
  // outside its folder, paying, and messaging someone new wait for the
  // owner. Only a grant scoped to the same place answers it — the owner's
  // "Allow for this task", or an "Always allow" keyed by folder, payee or
  // recipient (never the bare tool name, which is why an older `Bash:rm` or
  // `mcp__stripe__create_charge` grant cannot reach it). A turn nobody is
  // at uses neither: it holds the card, as every other unattended grant does.
  // No limits lifts the stop line for exactly the turns Full access covers;
  // a webhook, routine or someone else's turn is judged as before.
  const stop = origin !== "routine" && hasNoLimits(bot) && fullAccessCovers(bot, origin) ? null : context?.stopLine ?? null;
  const routineGrants = context?.routineLevel === true && !context.unattended && context.scope !== "local-computer"
    ? context.routineAllow ?? []
    : [];
  // Rule 68f, row kind "prompt-capable": a command that can ask for input
  // nobody would see, without its non-interactive form, holds its card with
  // its reason ahead of every standing answer (a stop-line place grant, the
  // task allowance, own-workspace, project-work-roots, a routine grant, the
  // exact and program grants, Auto mode). Full access and No limits keep
  // their standing: the owner chose no cards there.
  // It reads the command the engine reported and the shell line the call's
  // arguments carry; the card text only for a command tool that reported
  // neither, since a card title is not shell text.
  const prompt = fullAccessCovers(bot, origin) || promptText === undefined ? null : promptVerdict(promptText, context?.promptFacts);
  const promptHeld: AutoVerdict | null = prompt ? { approve: null, source: "prompt-guard", rule: prompt.rule, note: prompt.note } : null;
  // AMEND-13 Rule 79b: a connector batch of two or more rows is judged row by
  // row. Every finding must be covered by a cover that applies to it, and a
  // row's own covered findings authorize that row only; the remaining rows
  // need their action grant or a mode below. Used only when the rows agree
  // with the call's stop line (a finding only the title added keeps the
  // call-level hold).
  // A13-FIX-DESIGN C2: a one-row call (or any tool) whose finding names several
  // recipients is judged per recipient too, through the one splitter; a
  // combined key never stands in for them.
  const split = stop ? stopFindings(stop) : [];
  const rows = stop && context?.stopRows && context.stopRows.length > 1 && context.stopRows.some((row) => row.length) ? context.stopRows
    : split.length > 1 ? [split] : undefined;
  let coveredRows: ReadonlySet<number> = new Set();
  if (rows) {
    const keyGuard = keyHit();
    if (keyGuard) return { approve: null, source: sensitiveSource, rule: keyGuard };
    const covers: Array<{ source: string; key: string }> = [];
    for (const row of rows) for (const hit of row) {
      const cover = findingCover(bot, hit, context, routineGrants);
      if (!cover) return { approve: null, source: "stop-line", rule: hit.kind, note: hit.what };
      if (cover.source === "unattended-block") return { approve: null, source: "unattended-block", rule: cover.key };
      covers.push(cover);
    }
    const rule = [...new Set(covers.map((cover) => cover.key))].join(" ");
    const source = covers.every((cover) => cover.source === covers[0]!.source) ? covers[0]!.source as AutoVerdictSource : "always-allow";
    if (rows.every((row) => row.length)) return promptHeld ?? { approve: `auto-approved ${tool} (every step allowed)`, source, rule };
    coveredRows = new Set(rows.flatMap((row, index) => (row.length ? [index] : [])));
  }
  if (stop && !rows) {
    const attended = !context?.unattended && !context?.automated;
    const keyGuard = keyHit();
    if (keyGuard) return { approve: null, source: sensitiveSource, rule: keyGuard };
    if (context?.stopAllowedForTask && attended && context.scope !== "local-computer" && stopLineKeyCovers(context.stopAllowedForTask, stop)) {
      return promptHeld ?? { approve: `auto-approved ${tool} (allowed for this task)`, source: "task-allowance", rule: context.stopAllowedForTask };
    }
    const routineGrant = stopLineKey(stop) === undefined ? undefined : routineGrants.find((key) => isStopLineKey(key) && stopLineKeyCovers(key, stop));
    if (routineGrant) return promptHeld ?? { approve: `auto-approved ${tool} (always allowed for this routine)`, source: "routine-allow", rule: routineGrant };
    const granted = stopLineKey(stop) === undefined ? undefined : bot.alwaysAllow?.find((key) => isStopLineKey(key) && stopLineKeyCovers(key, stop));
    if (granted && context?.scope !== "local-computer") {
      if (context?.unattended) return { approve: null, source: "unattended-block", rule: granted };
      return promptHeld ?? { approve: `auto-approved ${granted} (always allowed)`, source: "always-allow", rule: granted };
    }
    return { approve: null, source: "stop-line", rule: stop.kind, note: stop.what };
  }
  // Full access raises no card for a turn the owner started, apart from the
  // stop line above and the key guard: a bot reading your keys is quiet,
  // permanent and unrecoverable, whichever level it is on.
  if (fullAccessCovers(bot, origin)) {
    // the key guard is the one stop No limits keeps too
    const keyGuard = sensitive ?? (destructive ? keyHit() : null);
    if (keyGuard) return { approve: null, source: sensitiveSource, rule: keyGuard };
    if (hasNoLimits(bot)) return { approve: `auto-approved ${tool} (no limits)`, source: "no-limits" };
    return { approve: `auto-approved ${tool} (full access)`, source: "full-access" };
  }
  // The prompt-capable hold (above). The guards keep their names, and so
  // does the unattended block when a grant would have answered.
  if (promptHeld) {
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: sensitiveSource, rule: sensitive };
    if (context?.unattended) {
      const would = standingGrant(bot, tool, summary, context, routineGrants, coveredRows);
      if (would) return { approve: null, source: "unattended-block", rule: would.rule };
    }
    return promptHeld;
  }
  // The bot's own bookkeeping, ahead of the unattended and host blocks
  // because those exist to stop a MODE or a GRANT standing in for a person,
  // and this is neither — nobody ever authorized Murage's own folders, and an
  // 8am routine that cannot write its own thread file simply never runs.
  //
  // It is placed BEHIND the two guards on purpose. They cost nothing here (a
  // bot does not normally write `rm -rf` or a `.env` into its own memory) and
  // keeping them in front means this can never become the one rule that lets
  // something the guards were written for through unattended.
  if (context?.projectWorkRoots === true && !destructive && !sensitive && !context.scope) {
    return { approve: `auto-approved ${tool} (project work folders)`, source: "project-work-roots" };
  }
  if (context?.ownWorkspace === true && !destructive && !sensitive && context.scope !== "local-computer") {
    return { approve: `auto-approved ${tool} (own workspace)`, source: "own-workspace" };
  }
  if (context?.ownToolResults === true && !destructive && !sensitive && !context.scope) {
    return { approve: "read its own saved tool result", source: "own-tool-results" };
  }
  // Murage's own tools that never ask on Claude or Codex (OWN_UNASKED) reach
  // here from an ACP engine (Fuigo, Grok Build), whose dispatcher asks for
  // every MCP call. They run without a card, on any turn, as they do on those
  // engines: a read (the roster, memory search, the app-tool lookup) at every
  // level, Ask included; any other row (ask_bot, memory_save) whenever the bot
  // is at Auto, unattended turns included, since Claude and Codex never ask
  // for them on any turn. Placed ahead of the unattended block on purpose: the
  // block stops a mode or grant standing in for a person, and these rows are
  // neither (OWN_UNASKED names the boundary that stands in for each). Always behind the guards
  // (a call that was cut, could not be proven, or names a key file is held
  // above), never for a host-scoped ask, and only for a call resolveCall
  // proved against this turn's own mount records, never one named by a title
  // or its arguments. publish_site and the other OWN_ALWAYS_ASK tools are in
  // neither table, so they keep asking.
  // Murage's own computer mount, a call that only looks at the screen
  // (OWN_COMPUTER_READS): no card at any level, host-scoped included, the
  // same on every engine. Only for a call proved on this turn's own mount
  // (never a title), behind the guards above; a click, a key or typing keeps
  // its level's rules below and asks at Ask.
  if (!destructive && !sensitive && resolved.kind === "mcp" && resolved.provenance === "own" && isOwnComputerRead(resolved.mountId, resolved.tool)) {
    return { approve: `auto-approved ${resolved.name} (looks at the screen)`, source: "own-unasked", rule: `${resolved.mountId}/${resolved.tool}` };
  }
  if (!destructive && !sensitive && !context?.scope && resolved.kind === "mcp" && resolved.provenance === "own") {
    const app = resolved.own ? ownAppTool(`mcp__${CONNECTED_APPS_SERVER}__${resolved.tool}`) : undefined;
    const read = app !== undefined ? APP_LOOKUPS[app] !== undefined : isOwnRead(resolved.mountId, resolved.tool);
    if (read || (bot.autoApprove && isOwnUnasked(resolved.mountId, resolved.tool))) {
      return { approve: `auto-approved ${resolved.name} (Murage's own tool)`, source: "own-unasked", rule: `${resolved.mountId}/${resolved.tool}` };
    }
  }
  // The grant is computed even when a hard block will refuse it: the row
  // worth auditing is "this WOULD have auto-approved, and only the block
  // stood in the way", which cannot be told apart from an ordinary
  // "nobody granted this" card without knowing both halves.
  const grant = destructive || sensitive ? null : standingGrant(bot, tool, summary, context, routineGrants, coveredRows);
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
    if (sensitive) return { approve: null, source: sensitiveSource, rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (context?.scope === "local-computer" && !bot.autoApprove) {
    // Host control is not covered by a remembered always-allow grant.
    // After the Auto-on-this-computer warning, unclassified GUI actions
    // (click/type) may auto-approve; destructive/sensitive still card.
    if (grant) return { approve: null, source: "local-computer-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: sensitiveSource, rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
  if (sensitive) return { approve: null, source: sensitiveSource, rule: sensitive };
  if (grant) return { approve: grant.approve, source: grant.source, rule: grant.rule };
  return { approve: null, source: "no-grant" };
}

/** Field names an engine's file tool names its path under. */
const PATH_FIELDS = ["path", "file_path", "filePath", "notebook_path", "paths", "file", "files", "target", "directory", "dir"];

/** What `realKeyPaths` found: the real place of every path this call names
 * whose real place differs from its spelling, and the first one that could
 * not be followed, if any. */
export interface RealKeyPaths { paths: string[]; cannot: string | null }

/** Where each path this call names really lands, links followed, resolved
 * part by part in order (shared/in-project.ts `realPathInOrder`, so `\` and
 * `/` both separate parts on Windows). A relative path is placed from `cwd`.
 * A missing tail is kept as written beneath its real folder, so a missing
 * path is not an error. A path that cannot be followed (a link loop, an
 * unreadable part, a climb past a missing folder, a relative path with no
 * folder) is `cannot`, and the key guard holds the call as a key read. */
export function realKeyPaths(input: unknown, filePaths: readonly string[] | undefined, cwd: string | undefined, opts: PlaceOptions = {}): RealKeyPaths {
  const given: string[] = [...(filePaths ?? [])];
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    for (const field of PATH_FIELDS) {
      const value = obj[field];
      for (const item of Array.isArray(value) ? value : [value]) if (typeof item === "string" && item) given.push(item);
    }
  }
  const home = opts.home ?? homedir();
  const paths: string[] = [];
  let cannot: string | null = given.length > 64 ? "the call names more paths than the key guard follows" : null;
  for (const path of given.slice(0, 64)) {
    const placed = realPathInOrder(path, cwd ?? "", { ...opts, home });
    if ("cannot" in placed) {
      cannot ??= `${path}: ${placed.cannot}`;
      continue;
    }
    if (placed.real !== path && !paths.includes(placed.real)) paths.push(placed.real);
  }
  return { paths, cannot };
}

/** Why this request may be answered without the human, or null to ask. */
export function autoDecision(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: AutoContext,
): string | null {
  return autoVerdict(bot, tool, summary, context).approve;
}
