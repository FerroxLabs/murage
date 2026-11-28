import { askShapeOf, type AskShape } from "./ask-shape.ts";
import { degradedWipeContext, wipeContextFor } from './wipe/context.ts';
import { noLimitsAppliesTo, permissionsForNoLimitsOrigin, type NoLimitsOrigin } from './no-limits-origin.ts';
import { inheritedPermissions, permissionsForOrigin } from "./permission-inheritance.ts";
import { nativeWipeBreaker } from "./wipe-breaker.ts";
import { HOME_OR_ROOT, noLimitsWipe, recursiveForceWord, wordsOf } from "./no-limits-wipe.ts";
import { writtenScriptRuns } from "./wipe/script-bodies.ts";
import { opendir as asyncOpendir, realpath as asyncRealpath } from "node:fs/promises";
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
import { actionGrantKey, actionGrantRead, actionGrantSet, commandArgument, placeArgumentScan, resolveCall, STAMP_SPELLING_WHY, type GrantCall, type ResolvedCall } from "../shared/app-action-grant.ts";
import { isStopLineKey, stopFindings, stopLineKey, stopLineKeyCovers, type StopHit } from "./stop-line.ts";
import { redactSecretsInText } from "./redact.ts";
import { decodeAnsiC, plainWipe, type OutsideMark, type ReadOnlyHooks } from "./outside-scan.ts";
import type { OutsideSource } from "./email/external-marks.ts";
import { ownerMarks, withoutDoubts } from "./shell/marks.ts";
import { alwaysAskCommand, alwaysAskNote, alwaysAskRoutineCommand, type CarvedTarget, ALWAYS_ASK_NO_LIMITS, COULD_NOT_READ_FINDINGS, protectedScriptHit, unreadableHit, type AlwaysAskHit, type UnseenOptions } from "./always-ask.ts";
import { commandCwdFromToolInput, commandFromToolInput, exactCommandKey, isExactCommandKey, routineExactGrantCovers, type ExactCommand } from "../shared/exact-command.ts";
import { approvalSummaryIsCut } from "../shared/approval-summary.ts";
import { SENSITIVE_RULES, SENSITIVE_PATHS } from "../shared/sensitive-paths.ts";
import { GATE_ROWS, gateHit, gateHitSpelled, ruleRowId } from "../shared/gate-files.ts";
import { countShellStart, shellProof, type ShellFloorCause, type ShellProofFacts, type ShellProofSource } from "./shell-proof.ts";
import { unresolvedShellParent, shellAndList, shellDirectoryEffects, type ShellCwdState, copyShellCwdState, admitShellPlace, admitShellPending, unionShellState, SHELL_MAX_PLACES, provenCdList, setsDotglob, linkCopyOperands, literalGlobPattern, globPatternText, pathGlobsIntersect, unavailableAnchoredGlobRead, rememberShellCwds, unknownShellGlobRead, type ShellCwdByThread, cdOperands, homeForm, placedGlobs, globKeyRead } from "../shared/sensitive-globs.ts";
import { fileToolRead, splitCommand, isReadPassHold, keyRowId, keyValueShapeIn, PATH_RULES, readKindRules, TEXT_RULES, type CommandDataRead, type FileToolRead } from "./key-text.ts";
import { powershellRunner } from "./shell/pwsh.ts";
import { lex, Unreadable, type Part, type Word } from "./shell/lex.ts";
import { noLimitsProtectedWrite, structuredProtectedWrite } from "./no-limits-protected.ts";
import { parse, type Script } from "./shell/parse.ts";
import { braceCandidates } from "./shell/walk.ts";
import { isGlobWord, shellGlobWords } from "./x3-glob-words.ts";
import { dataCredentialHit } from "../shared/data-credential-paths.ts";
import { legacyGlobKeyRead } from "../shared/legacy-glob-key-read.ts";
import { requiredFields } from "./drivers/contracts.ts";
import { homedir } from "node:os";
import { realPathInOrder, win32Canonical, type PlaceOptions } from "../shared/in-project.ts";
import { isOwnAlwaysAsk, isOwnComputerRead, isOwnHandlerCarded, isOwnQuiet, isOwnUnasked, ownAlwaysAskByName, ownWebSearchRunsUnasked } from "../shared/own-servers.ts";
import { APP_LOOKUPS, ownAppTool } from "../shared/app-action-words.ts";
import { pinOverrideIn, promptVerdict, type PromptFacts } from "../shared/prompt-capable.ts";
import { bareToolName, isBareCommandGrant, isCommandTool, isQuestionGrant, isQuestionTool } from "../shared/grant-tool-names.ts";

// moved to shared/grant-tool-names.ts (1.0.13 L1a) so the client's fold and
// shared/durable-grant-allowed.ts read the same shapes; re-exported unchanged
export { isBareCommandGrant, isCommandTool, isQuestionGrant, isQuestionTool };

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
// shared/sensitive-paths.ts (Rule 35), the one list every gate imports. At No
// limits on a turn the owner started himself only its gate files ask (`ownerNoLimits`).
const SENSITIVE = SENSITIVE_RULES;

export function withoutQuestionGrants(keys: string[]): string[] {
  return keys.filter((key) => !isQuestionGrant(key));
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

/**
 * The key guard's second read of a shell command (1.0.7): its words as bash will hand them to the program, quotes
 * removed and braces multiplied out, so a spelling split by quotes (`~/.fu''igo/config.toml`, `~/.ss"h"/id_rsa`)
 * or by a brace (`~/.{ssh,x}/id_rsa`) meets the same rows as the plain one. A substitution's own text is read the
 * same way. `homeGlob` names a glob or brace that picks a folder or file directly in the home folder, or anywhere
 * under a dot folder there (`~/.*rc`, `~/*\/config.toml`, `$HOME/.fu*o/x`): no reader can say which key file that
 * is, so it is held as one. A command the lexer cannot read gives undefined; the always-ask reader holds those.
 */
export function dequotedShellText(text: string, depth = 0): { text: string; globText: string; globWords: string[]; homeGlob?: string } | undefined {
  // past this depth the text is not read: held, never handed on with its quotes
  if (depth > 4) return { text: "", globText: "", globWords: [], homeGlob: "substitutions nested too deep to read" };
  let tokens;
  try { tokens = lex(text); } catch (error) {
    if (error instanceof Unreadable) return undefined;
    return { text: "", globText: "", globWords: [], homeGlob: "a command the reader could not read" };
  }
  const out: string[] = [];
  const globOut: string[] = [];
  const globWords: string[] = [];
  let homeGlob: string | undefined;
  // globText: the same words with a quoted or escaped `*`, `?` or `[` kept literal, so only a real glob meets the
  // glob reader (`echo $'\?'` prints a question mark; it names no file)
  const render = (parts: readonly Part[], forGlob: boolean): string => parts.map((part) => {
    switch (part.kind) {
      // an unquoted `*` or `?` lexes as a glob part, so one in a lit was quoted or escaped; an unquoted `[` stays a
      // lit (the lexer does not model brackets), so only a quoted one is neutralized
      case "lit": return forGlob ? part.text.replace(part.quote === "none" ? /[*?]/g : /[*?[\]]/g, "_") : part.text;
      case "tilde": return `~${part.user}`;
      // `${NAME:+word}` and kin: bash may hand on the operand, so it is read as words too
      case "var": {
        if (!part.word) return `$${part.name}`;
        // `${X:-w}`, `${X:+w}`, `${X=w}`: the operand is a value bash may hand on. After `#`, `%`, `/`, `^`, `,` or
        // `:` it is a pattern, a replacement or an offset: its words still meet the rows, its globs match nothing
        const value = /^:?[-=+?]$/.test(part.op ?? "");
        if (value) homeGlob ??= homeGlobIn(part.word);
        const operand = render(part.word.parts, forGlob);
        return `$${part.name} ${forGlob && !value ? operand.replace(/[*?[\]]/g, "_") : operand} `;
      }
      case "glob": return part.text;
      case "brace": return "";
      case "subst": case "arith": case "procsub": {
        const inner = dequotedShellText(part.text, depth + 1);
        if (inner?.homeGlob) homeGlob ??= inner.homeGlob;
        return inner ? ` ${forGlob ? inner.globText : inner.text} ` : ` ${part.text} `;
      }
    }
  }).join("");
  // Keep each shell word intact. The historical text render above is unchanged.
  const renderWords = (parts: readonly Part[]): string[] => {
    let choices = [""];
    for (const part of parts) {
      let values: string[];
      if (part.kind === "var") {
        values = ["$" + part.name];
        if (part.word && /^:?[-=+?]$/.test(part.op ?? "")) {
          const operands = renderWords(part.word.parts);
          values.push(...operands);
          // lexWordText joins operand words. Read this ambiguous rooted operand as a whole.
          if (operands.some(value => /[*?]|\[.*\]/.test(value) && /(?:\/tmp|\/private\/tmp|\/var\/folders|murage-|\$\{?(?:TMPDIR|TEMP|TMP|HOME|USERPROFILE|MURAGE_DATA_DIR)|~\/|[a-z]:[\\/])/i.test(value))) globWords.push("\u0001credential-glob-overflow*");
        } else if (part.op && /^(?:TMPDIR|TEMP|TMP|HOME|USERPROFILE|MURAGE_DATA_DIR)$/.test(part.name) && parts.some(p => p.kind === "glob")) globWords.push("\u0001credential-glob-overflow*");
      } else if (part.kind === "subst" || part.kind === "procsub" || part.kind === "arith") {
        globWords.push(...(dequotedShellText(part.text, depth + 1)?.globWords ?? []));
        values = [""];
      } else values = [render([part], true)];
      choices = choices.flatMap(prefix => values.map(value => prefix + value));
      if (choices.length > 256) { globWords.push("\u0001credential-glob-overflow*"); return []; }
    }
    return choices;
  };
  for (const token of tokens) {
    // an unquoted heredoc body runs its substitutions: the body is read as words of its own
    if (token.kind === "op" && token.heredoc && !token.heredoc.quoted && /\$\(|`/.test(token.heredoc.body)) {
      const body = dequotedShellText(token.heredoc.body, depth + 1)
        ?? { text: "", globText: "", homeGlob: "a heredoc substitution the reader could not read" };
      out.push(body.text); globOut.push(body.globText); globWords.push(...("globWords" in body ? body.globWords : []));
      homeGlob ??= body.homeGlob;
      continue;
    }
    if (token.kind !== "word") continue;
    const word: Word = token.word;
    homeGlob ??= homeGlobIn(word);
    let candidates: Word[];
    try { candidates = braceCandidates(word); } catch { candidates = [word]; homeGlob ??= "a brace with too many values"; }
    for (const candidate of candidates) { out.push(render(candidate.parts, false)); globOut.push(render(candidate.parts, true)); globWords.push(...renderWords(candidate.parts)); }
  }
  return { text: out.join(" "), globText: globOut.join(" "), globWords, ...(homeGlob ? { homeGlob } : {}) };
}

/** A glob or brace in the first segment under the home folder, or in any segment at or below a dot folder there. */
function homeGlobIn(word: Word): string | undefined {
  const [first] = word.parts;
  if (!first) return undefined;
  const homeVarNames = new Set(["HOME", "USERPROFILE"]);
  let text = "";
  let anchored = first.kind === "tilde" || (first.kind === "var" && homeVarNames.has(first.name));
  let start = anchored ? 0 : -1;
  for (const part of word.parts) {
    if (part.kind === "lit") {
      text += part.text;
      if (!anchored) {
        const home = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/i.exec(text);
        if (home) { anchored = true; start = home[0].length; }
      }
      continue;
    }
    if (!anchored) { if (part.kind !== "tilde" && part.kind !== "var") return undefined; continue; }
    if (part.kind !== "glob" && part.kind !== "brace") { text += "\u0001"; continue; }
    const under = text.slice(start).replace(/^[\\/]+/, "");
    const segments = under.split(/[\\/]+/);
    if (segments.length <= 1 || segments.slice(0, -1).some((segment) => segment.startsWith("."))) return `a ${part.kind} in a path under the home folder`;
    text += "\u0001";
  }
  return undefined;
}

/** 1.0.10 (NOLIMITS-CARDS): the key guard's copy of a command the lexer could not read. Quotes and backslashes are taken out and each `{a,b}` is
 * written out both ways, so `cat ~/.ss"h/id_rsa` with a stray quote meets the same rows; a glob or brace under home
 * is held by the same rule as `homeGlobIn`. Coarse on purpose: it can only hold more. */
export function rawDequotedText(text: string, pwsh = false): { text: string; globText: string; homeGlob?: string } {
  // PowerShell: a backslash is a path separator and the backtick the escape (GrokBuild G2)
  const plain = (pwsh ? text.replace(/`(.)/g, "$1").replace(/\\/g, "/") : decodeAnsiC(text).replace(/\\(.)/g, "$1")).replace(/["'`]/g, "").replace(/\$\{(HOME|USERPROFILE)\}/g, "$$$1");
  const words: string[] = [];
  let homeGlob: string | undefined;
  for (const word of plain.split(/[\s;|&()<>]+/)) {
    if (!word) continue;
    let expanded = [word];
    for (let k = 0; k < 4 && expanded.some((one) => /\{[^{}]*,[^{}]*\}/.test(one)) && expanded.length < 256; k++) {
      expanded = expanded.flatMap((one) => {
        const m = /\{([^{}]*,[^{}]*)\}/.exec(one);
        return m ? m[1]!.split(",").map((alt) => one.slice(0, m.index) + alt + one.slice(m.index + m[0].length)) : [one];
      });
    }
    if (/[{}]/.test(expanded.join(" ")) && /^(?:~|\$HOME|\$USERPROFILE|\/Users\/|\/home\/|\/root|[A-Za-z]:[\\/]Users)/i.test(word)) homeGlob ??= "a brace in a path under the home folder";
    for (const one of expanded) {
      words.push(one);
      homeGlob ??= rawHomeGlob(one);
    }
  }
  const joined = words.join(" ");
  return { text: joined, globText: joined, ...(homeGlob ? { homeGlob } : {}) };
}

/** `homeGlobIn` over plain text, the 1.0.9 rule: a glob in the first segment under home, or in any segment at or below
 * a dot folder there, holds (1.0.10: the 1D glob walk was cut and goes to 1.0.11). */
function rawHomeGlob(word: string): string | undefined {
  const home = /^(?:~|\$HOME|\$USERPROFILE|\$env:USERPROFILE|%USERPROFILE%|\/Users\/[^/\\]+|\/home\/[^/\\]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/i.exec(word);
  if (!home) return undefined;
  const segments = word.slice(home[0].length).replace(/^[\\/]+/, "").split(/[\\/]+/);
  const at = segments.findIndex((segment) => /[*?[]/.test(segment));
  if (at < 0) return undefined;
  if (at === 0 || segments.slice(0, at).some((segment) => segment.startsWith("."))) return "a glob in a path under the home folder";
  return undefined;
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

/** Is this a PowerShell tool? Its command text is PowerShell's, whatever it
 * starts with, and it is read by the PowerShell readers. */
export function isPowerShellTool(tool: string): boolean {
  return POWERSHELL_TOOLS.has(bareToolName(tool));
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

/** The whole command for the always-ask reader (server/index.ts approval context): the engine's own text, uncapped, from the folder
 * the call names for this one command, else the turn's folder. Only a command tool carries one, and only when its input holds a
 * command; any other call (an MCP tool, a file write) gives nothing, so the reader reads its card text instead. A named folder
 * that is not a usable path is marked invalid and never replaced by the turn's folder (MARKS-r14 rule 11, D3). */
export function wholeCommandOf(tool: string, input: unknown, turnCwd: string | undefined): Pick<AutoContext, "commandText" | "commandCwd" | "commandCwdInvalid"> {
  if (!isCommandTool(tool)) return {};
  const commandText = commandFromToolInput(input);
  if (commandText === undefined) return {};
  const named = commandCwdFromToolInput(input);
  if (named === null) return { commandText, commandCwdInvalid: true };
  const commandCwd = named === undefined ? turnCwd : named ?? undefined;
  return commandCwd === undefined ? { commandText } : { commandText, commandCwd };
}

export interface AutoApprover {
  draftOnly?: boolean;
  permissionExplicit?: boolean;
  permissionRev?: number;
  /** Server-owned identity for value-free approval diagnostics. */
  id?: string;
  autoApprove?: boolean;
  /** Full access, the level above Auto. It counts only while `autoApprove`
   * is on too, so every path that switches Auto off ends it as well. */
  fullAccess?: boolean;
  /** Full access also covers the owner's own messages from Telegram, Slack
   * and Discord. Off unless it is exactly `true`. */
  fullAccessChannelMessages?: boolean;
  /** No limits, above Full access: only catastrophe/wipe permission cards.
   * Origin eligibility is shared with the registered decision layer. */
  noLimits?: boolean;
  alwaysAllow?: string[];
}

/** Is this bot (or task) on Full access? */
export function hasFullAccess(bot: AutoApprover | null | undefined): boolean {
  const effective = bot && inheritedPermissions(bot);
  if (effective?.draftOnly) return false;
  return effective?.autoApprove === true && effective.fullAccess === true;
}

/** Is this bot (or task) on No limits? Only on top of Full access. */
export function hasNoLimits(bot: AutoApprover | null | undefined): boolean {
  const effective = bot && inheritedPermissions(bot);
  return hasFullAccess(effective) && effective?.noLimits === true;
}

/** Who started the turn, as Full access reads it: the owner at the desktop
 * (or a bot the owner's turn reached), the owner's own message from
 * Telegram, Slack or Discord, a scheduled or manual run of one of the owner's
 * routines judged at that routine's own level (server/routine-permissions.ts),
 * or anyone and anything else — a webhook, another person's channel message,
 * a turn whose origin could not be proven. */
export type FullAccessOrigin = "owner" | "owner-channel" | "routine" | "other";

/** Does Full access cover a turn from this origin? The owner's own channel
 * DMs unless the owner turned the bot's option off. A routine run is covered when
 * the level it is judged at is Full access or No limits: the caller has
 * already applied the routine's level to `bot`, so the flags ARE that level.
 * Everything else never. */
export function fullAccessCovers(bot: AutoApprover | null | undefined, origin: FullAccessOrigin): boolean {
  if (!hasFullAccess(bot)) return false;
  if (origin === "owner" || origin === "routine") return true;
  // 1.0.10 (NOLIMITS-CARDS r2): on unless the owner turned it off
  return origin === "owner-channel" && bot?.fullAccessChannelMessages !== false;
}

/** Why a verdict landed the way it did. `unattended-block` exists only in
 * contrast: a grant WOULD have fired, and the only thing that stopped it
 * was that nobody started this turn — the most audit-worthy card of all. */
export type AutoVerdictSource =
  | "owner-switch"
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
  /** No limits: Full access without the stop line (see `ownerNoLimits` for what the key guard keeps). */
  | "no-limits"
  /** The bot writing inside its OWN managed workspace or thread
   * folder. Not a grant and not a mode — the action was never the person's
   * to authorize (see the comment on `ownWorkspace` below). */
  | "own-workspace"
  /** The bot reading its own files (server/own-file-reads.ts). */
  | "own-files"
  /** The bot reading back its OWN saved tool result: a read-only command or
   * read tool on a file in this session's own result folder
   * (server/own-tool-results.ts). Not a grant and not a mode. */
  | "own-tool-results"
  | "project-work-roots"
  /** One of Murage's own tools that runs unasked on Claude and Codex
   * (shared/own-servers.ts OWN_UNASKED), asked for by an ACP engine whose
   * dispatcher files every MCP call as a permission. A read (OWN_READS, a phone tool
   * in PHONE_PREALLOWED, or a connected-app lookup) is answered at every level, Ask included; any other
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
  /** Legacy lower-level policy (design r4 6.1): an owner No limits lane turn that read outside content (or whose state
   * the server did not state) asks before every shell text that is not a read-only shape and every acting tool.
   * `rule` is `outside-content`, `note` names the first source. Never waived; offers no grant. */
  | "outside-turn"
  | "question-tool"
  | "no-grant";

export interface AutoVerdict {
  classification?: "deny" | "ask";
  reason?: string;
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
  /** 1.0.10 (r5): for an unreadable hold, the value-free reader class (`held`) for the log. */
  reader?: string;
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
    case "outside-turn": return verdict.note ?? outsideTurnNote(undefined);
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
  wipeThreadId?:string; wipeBotId?:string;
  shellCwdByThread?: ShellCwdByThread;
  globExpansionRule?: string | null;
  /** Attributed expansion findings, independent of the first winning reason. */
  globFindings?: readonly CredentialGlobOutcome[];
  shellCwdPrepared?: boolean;
  threadId?: string;
  /** Server-proven origin, separate from the older Full access policy. */
  noLimitsOrigin?: NoLimitsOrigin;
  /** Existing server turn-origin fact, never taken from engine input. */
  fullAccessOrigin?: FullAccessOrigin;
  /** NOLIMITS-MEANS-IT: this call belongs to the bound provider turn of a run the owner started directly. Read from the
   * server's own run record at each ask; absent means false. Never copied to a held item, a message or disk. */
  ownerStarted?: boolean;
  /** Legacy lower-level policy (design r4 3.1, C2): the marks this turn carried BEFORE this call. `null` = a clean turn,
   * filled by the server only when its outside store is wired and loaded (3.5). Absent counts as marked: no relief. */
  outsideRead?: readonly (OutsideMark | OutsideSource)[] | null;
  /** Legacy lower-level policy (section 1, r3): the engine has no pre-run seam at No limits (OpenClaw). The lane does
   * not apply: exactly today's behaviour, clean or marked. */
  noPreRunSeamAtNoLimits?: boolean;
  /** Legacy lower-level policy (6.3): no call of this engine session wrote since it was tainted. Only `true` lets a
   * read-only shape (6.2) run on a marked lane turn; absent is false. */
  readOnlySoFar?: boolean;
  /** Legacy lower-level policy (6.2): the hooks the read-only shape check runs with (cwd, `sessionEdits`, the registry
   * check, the PATH lookup on the shared 64-syscall budget). Absent: no shell text is read-only on a marked turn. */
  readOnlyHooks?: ReadOnlyHooks;
  /** Legacy lower-level policy (6.1.3): the engine's working folder. Absent: every engine file edit on a marked lane
   * turn asks. */
  workFolder?: string;
  /** the engine's whole command, uncapped, for the always-ask reader (the
   * 4,000-character `exactCommand` copy exists for the exact grant, which
   * must stay bounded; a catastrophe after the cut must still be read) */
  commandText?: string;
  /** the folder the engine says `commandText` runs in, when it names one */
  commandCwd?: string;
  commandCwdInvalid?: boolean;
  runtimePaths?: Readonly<Record<string, string>>;
  /** Known command environment for the bounded No limits root expansion. */
  commandEnv?: Readonly<Record<string, string | undefined>>;
  projectRoots?: readonly string[] | (() => readonly string[]);
  dataDir?: string;
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
  /** Provenance only (design R3): the driver did not hand over the whole call. A cut the card alone made is `inputCut`. */
  inputTruncated?: boolean;
  /** The caller found the live scheduled or manual routine run that owns
   * this conversation, and records in that run's history any command the
   * routine carve-out lets through (`AutoVerdict.valueTarget`). Honoured only
   * with `routineLevel`; a peer bot's turn for a routine never sets it. */
  routineCarveOut?: boolean;
  /** U20 (Rule 74d): the F12 record says the environment check failed, with this cause. The command is unread: held
   *  with the cause at every level, as any call that could not be read whole. */
  envUnread?: string;
  envUnchecked?: import("../shared/mount-identity.ts").ExecEnv["unchecked"];
  /** the turn was started by an outside event, with nobody at the keyboard */
  unattended?: boolean;
  /** the request controls the user's active desktop */
  scope?: "local-computer";
  /** 1.0.9: the disk reads the unseen-script check makes and the shell its
   * text is read as (always-ask.ts UnseenOptions); unset, this computer's own
   * disk and shell. Tests and the corpus pass a stub and name the shell. */
  unseen?: UnseenOptions;
  sessionFile?: UnseenOptions["sessionFile"];
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
  /** The bot reading its own files: its SOUL.md, skills, memory and
   * conversation folders, never credentials/. Decided in
   * server/own-file-reads.ts (a read tool or a strictly read-only command,
   * every path inside the bot's own folders by real path) and set only for a
   * turn the workspace owner is behind; placed like `ownToolResults`. */
  ownFileRead?: boolean;
  projectWorkRoots?: boolean;
  /** The requesting engine's handed PATH and PATHEXT (WIN-PWSH-1018 H1), from its F12 record; missing, pwsh `bash` holds. */
  handedShellPath?: UnseenOptions["bashResolve"];
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

/** The card's words for an OWN_ALWAYS_ASK tool held at Ask or Auto. */
const OWN_ALWAYS_ASK_NOTE = "Murage checks with you every time before this runs.";

/** Rule 51: the OWN_ALWAYS_ASK pair this ask runs (`own:<builtin>/<tool>`),
 * or undefined. A call resolveCall proved against this turn's mounts is
 * judged by its mount: an own mount's row, never another server's tool of
 * the same name. Otherwise the engine's MCP-qualified name (the tool, or the
 * call's own name) is read against the own server names. Matching a name
 * only ever holds a card, so reading it is the safe direction. */
function ownAlwaysAskOf(tool: string, resolved: ResolvedCall, call: GrantCall | undefined): string | undefined {
  if (resolved.kind === "mcp") {
    return resolved.provenance === "own" && isOwnAlwaysAsk(resolved.mountId, resolved.tool) ? `${resolved.mountId}/${resolved.tool}` : undefined;
  }
  return ownAlwaysAskByName(tool) ?? ownAlwaysAskByName(call?.toolCall?.name);
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

const askedWindows = new Map<string, { at: number; suppressed: number }>();
/** NOLIMITS-KEY-TEXT 3.7: why the key guard held a verdict, by fixed name, for the asked line only. */
type KeyWhy = "path" | "value" | "field" | "mcp" | "summary" | "unmodeled" | "pwsh" | "local-hold";
const keyWhyOf = new WeakMap<AutoVerdict, KeyWhy>();
/** APPROVALS-SIMPLE-1018: why the reader held an `unreadable` hit, a fixed content-free name (UnseenWhy and three more). */
const readerWhyOf = new WeakMap<AutoVerdict, string>();
const readerShapeOf = new WeakMap<AutoVerdict, AskShape>();
const ASK_LOG_MS = 60_000;
const ALWAYS_ASK_LOG_RULES = new Set(["delete-root", "delete-home", "delete-system-folder", "disk-erase", "fork-bomb", "unknown-target", "protected-path"]);
const GATE_LOG_ROWS = new Set(GATE_ROWS.map(row => row.id));

const LOCAL_HOLD_WORDS = "the engine's own check held this as a key file";
const REAL_PATH_WORDS = "a path this call names could not be followed to where it lands, so it is held as a key file";
const HOME_GLOB_WORDS = " could name a key file";

/** The bot's own level. A turn it does not cover shows as origin= beside it. */
function askLevel(bot: AutoApprover): "ask" | "auto" | "full" | "no-limits" {
  return hasNoLimits(bot) ? "no-limits" : hasFullAccess(bot) ? "full" : bot.autoApprove === true ? "auto" : "ask";
}

/** What held the call at the key guard or the reader, by fixed name only; undefined for every other card. */
function askHeldClass(verdict: AutoVerdict): "key-row" | "home-glob" | "local-hold" | "real-path" | "unread" | undefined {
  if (verdict.source === "unread-call" || (verdict.source === "always-ask" && verdict.rule === "unreadable")) return "unread";
  if (verdict.source !== "sensitive-guard") return undefined;
  const rule = verdict.rule ?? "";
  if (rule.startsWith(LOCAL_HOLD_WORDS)) return "local-hold";
  if (rule.startsWith(REAL_PATH_WORDS)) return "real-path";
  return rule.endsWith(HOME_GLOB_WORDS) && !rule.startsWith("a glob too deep") ? "home-glob" : "key-row";
}

/** No free-text rule, note, argument, path or grant key enters a log line. */
function askReasonClass(verdict: AutoVerdict): string {
  if (verdict.source === "always-ask") {
    if (verdict.rule === "unreadable") return "unreadable";
    return ALWAYS_ASK_LOG_RULES.has(verdict.rule ?? "") ? `always-ask:${verdict.rule}` : "always-ask:own-tool";
  }
  if (verdict.source === "unread-call") {
    const rule = verdict.rule ?? "";
    if (rule.startsWith(U20_WORDS)) return "unread-call:U20";
    if (rule.startsWith(U19_WORDS)) return "unread-call:U19";
    if (rule === "the call was cut before it could be checked") return "unread-call:truncated";
    if (rule === "the call's arguments run past what the key guard reads") return "unread-call:scan";
    if (rule.endsWith(STAMP_SPELLING_WHY)) return "unread-call:stamp-spelling";
    if (rule.startsWith("the tool this runs cannot be proven:")) return "unread-call:identity";
    if (rule.startsWith("the call does not carry what this tool needs")) return "unread-call:contract";
    return "unread-call:actions";
  }
  if (verdict.source === "stop-line") return ["delete", "pay", "message"].includes(verdict.rule ?? "") ? `stop-line:${verdict.rule}` : "stop-line:other";
  return verdict.source;
}

/** One ask line per bot/tool/class/minute; the next line reports suppressed repeats. */
function logAsked(bot: AutoApprover, tool: string, verdict: AutoVerdict, context?: AutoContext, prior?: AutoVerdict): void {
  if (verdict.approve !== null) {
    if (verdict.source !== "no-limits") return;
    const botId = bot.id && /^[\w-]{1,128}$/.test(bot.id) ? bot.id : "unknown";
    const toolName = /^[a-zA-Z][\w.:-]{0,127}$/.test(tool) ? tool : "unknown";
    const reason = askReasonClass(prior ?? verdict);
    const heldRow = prior?.rule?.startsWith("held=gate:") ? prior.rule.slice("held=gate:".length) : undefined;
    const row = ruleRowId(prior?.rule) ?? keyRowId(prior?.rule) ?? (heldRow && GATE_LOG_ROWS.has(heldRow) ? heldRow : undefined);
    console.info(`approvals: auto bot=${botId} tool=${toolName} reason=${reason}${row ? ` row=${row}` : ""} level=no-limits initiator=${noLimitsInitiator(bot, context)}`);
    return;
  }
  const botId = bot.id && /^[\w-]{1,128}$/.test(bot.id) ? bot.id : "unknown";
  const toolName = /^[a-zA-Z][\w.:-]{0,127}$/.test(tool) ? tool : "unknown";
  const reason = askReasonClass(verdict), held = askHeldClass(verdict), key = JSON.stringify([botId, toolName, reason, held]), now = Date.now();
  const previous = askedWindows.get(key);
  if (previous && now - previous.at < ASK_LOG_MS && now >= previous.at) { previous.suppressed++; return; }
  askedWindows.set(key, { at: now, suppressed: 0 });
  // 1.0.10 (NOLIMITS-CARDS r5): who started the turn and what kind of command it was, value-free, so a report can
  // tell an owner's turn from a webhook from the log alone
  const origin = fullAccessOriginOf(context);
  const cmd = !isCommandTool(tool) && context?.exactCommand === undefined ? "none" : isPowerShellTool(tool) || context?.call?.commandShell === "pwsh" ? "pwsh" : "shell";
  const reader = verdict.reader ? ` reader=${verdict.reader}` : "";
  // Legacy lower-level policy (design 11): every ask of a marked lane turn names its first source, a fixed mark name
  const outsideMark = markedLaneTurn(bot, context) ? (context?.outsideRead?.[0] ?? "unknown") : undefined;
  const outsideField = outsideMark !== undefined && /^[a-z ]{1,32}$/.test(outsideMark) ? ` outside=${outsideMark.replace(/ /g, "-")}` : "";
  // NOLIMITS-MEANS-IT and KEY-TEXT: fixed names only: whether the owner started this turn, a row's id and the class of read, never a path, a name or command text
  const keyRow = held === "key-row" || held === "local-hold" ? keyRowId(verdict.rule) : undefined;
  const row = keyRow ?? (verdict.source === "sensitive-guard" ? ruleRowId(verdict.rule) : undefined);
  const why = keyWhyOf.get(verdict) ?? readerWhyOf.get(verdict);
  const keyFields = `${row ? ` row=${row}` : ""}${why ? ` why=${why}` : ""}`;
  const initiatorField = hasNoLimits(bot) ? ` initiator=${noLimitsInitiator(bot, context)}` : "";
  console.info(`approvals: asked bot=${botId} tool=${toolName} reason=${reason} origin=${origin} unattended=${context?.unattended ? 1 : 0} cmd=${cmd}${reader} level=${askLevel(bot)}${initiatorField} owner=${context?.ownerStarted === true ? 1 : 0}${held ? ` held=${held}` : ""} suppressed=${previous?.suppressed ?? 0}${keyFields}${outsideField}${readerShapeOf.has(verdict) ? ` shape=${readerShapeOf.get(verdict)}` : ""}`);
}

/** Sean ruling 2026-11-12 02:05Z. All No limits calls take this path,
 * including outside, unattended, cut and failed-reader calls. Other levels
 * continue through the existing policy without any changed guards. Every card
 * it raises is a wipe (ALWAYS_ASK_NO_LIMITS), so it carries the deny class. */
function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {
  if (context?.question || isQuestionTool(tool)) return {approve:null,source:"question-tool"};
  const safe = <T>(read: () => T): T | undefined => { try { return read(); } catch { return undefined; } };
  const command = safe(() => context?.commandText) ?? safe(() => context?.exactCommand?.command);
  const call = safe(() => context?.call);
  const executable=isCommandTool(tool)||call?.toolKind==='execute'||/^(?:use_tool|exec|execute_command|start_process|run)$/.test(bareToolName(tool));
  const inner = executable?safe(() => commandArgument(call?.toolCall?.input)):undefined;
  const shell: 'pwsh' | undefined = isPowerShellTool(tool) || call?.commandShell === "pwsh" ? "pwsh" : undefined;
  const input = safe(() => call?.toolCall?.input);
  const request={cwd:safe(()=>context?.commandCwd)??safe(()=>context?.exactCommand?.cwd)??safe(()=>context?.workFolder),project:safe(()=>context?.workFolder),home:safe(()=>context?.promptFacts?.home),dataDir:safe(()=>context?.dataDir)};
  let shared:import('./wipe/types.ts').WipeContext;try{shared=wipeContextFor(context?.wipeThreadId,context?.wipeBotId,request);}catch{shared=degradedWipeContext(request,context?.wipeBotId);}
  const wipeContext = { ...shared, cwdOpaque:safe(()=>context?.commandCwdInvalid)??shared.cwdOpaque, cwd: safe(() => context?.commandCwd) ?? safe(() => context?.exactCommand?.cwd) ?? safe(() => context?.workFolder) ?? safe(() => context?.promptFacts?.cwd) ?? shared.cwd,
    project: safe(() => context?.workFolder) ?? safe(() => context?.promptFacts?.cwd) ?? shared.project, home: safe(() => context?.promptFacts?.home) ?? shared.home, env: safe(() => context?.commandEnv) ?? safe(() => context?.runtimePaths) ?? shared.env,
    dataDir: safe(() => context?.dataDir) ?? shared.dataDir, shell,
    // OVERREACH #6: a script this session wrote is read for the wipe check
    sessionEdits: safe(() => context?.readOnlyHooks?.sessionEdits) ?? safe(() => context?.unseen?.sessionEdits) ?? shared.sessionEdits, sessionFile: safe(() => context?.sessionFile) ?? safe(() => context?.unseen?.sessionFile) ?? shared.sessionFile };
  if(/^(?:execute_code|python|python3|node|javascript)$/i.test(tool)){
   const code=safe(()=>typeof input==='string'?input:(input as {code?:unknown;script?:unknown})?.code??(input as {script?:unknown})?.script);
   if(typeof code==='string'){const found=noLimitsWipe(code,{...wipeContext,lang:/node|javascript/i.test(tool)?'js':'py'});if(found)return {approve:null,source:'always-ask',rule:found.rule,classification:'deny',reason:found.rule,note:found.what};}
  }
  const native = nativeWipeBreaker(tool, input, wipeContext);
  if (native) return { approve: null, source: "always-ask", rule: native.rule, classification: "deny", reason: native.rule, note: native.what };
  const texts = new Set([command, inner, ...(!executable || command !== undefined || inner !== undefined ? [] : [summary])]);
  for (const text of texts) if (text !== undefined) {
    // MAIN-RULING NOLIMITS-1022 H1 correction: an obfuscated wipe asks too, decoded as far as it decodes (noLimitsWipe)
    const wipe = noLimitsWipe(text, wipeContext);
    if (wipe) return { approve: null, source: "always-ask", rule: wipe.rule, classification: "deny", reason: wipe.rule, note: wipe.what };
    // MAIN-RULING NOLIMITS-1022 H1 correction: an obfuscated wipe asks too, decoded as far as it decodes
  }
  return { approve: `auto-approved ${tool} (no limits)`, source: "no-limits" };
}

/** 1.0.22 MAIN-RULING NOLIMITS-1022 H1 (Sean 11-10/11-11/11-12: Full access and No limits ask only for deny rules and
 * the wipe list): on a turn Full access covers, an `unreadable` hit (the reader could not follow the text and named
 * nothing) runs unless the wipe check No limits uses finds a wipe in it, decoded as far as it decodes (`$(echo rm) -rf ~`
 * still asks). A deny-class, mandatory or named-catastrophe hit is never lifted, and the key guard, the stop line and
 * every guard after the always-ask read still judge the call. It runs only what the owner's No limits verdict
 * (noLimitsOnlyVerdict) runs, so Full access is never looser than No limits. No limits never gets here. */
function fullAccessUnreadableRuns(bot: AutoApprover, tool: string, summary: string, context: AutoContext | undefined, hit: AlwaysAskHit, texts: readonly (string | undefined)[], ownerRead: () => AlwaysAskHit | null): boolean {
  if (hit.rule !== "unreadable" || hit.classification === "deny" || hit.mandatory || hit.namedCatastrophe) return false;
  // a command relayed to the owner's own computer is a host boundary, not a reader doubt: it keeps its card
  if (hit.unseenWhy === "relayed") return false;
  // a cut or truncated call: the wipe may sit after the cut, so no wipe check has seen it
  if (context?.inputCut === true || context?.inputTruncated === true || context?.call?.truncated === true) return false;
  // N1 (1.0.19) command completeness: an unread environment or path, or a call whose tool is not a proven command tool, keeps its card
  if (context?.envUnread !== undefined || context?.realPathCannot !== undefined) return false;
  const call = context?.call;
  if (call && (resolveCall(call).kind === "unproven" || !(call.toolKind === "execute" || isCommandTool(call.toolCall?.name ?? "")))) return false;
  // a turn with no stored origin is unproven (Sean 11-12: unproven stays Ask); Full access's own default reads it as the owner's
  if (context?.fullAccessOrigin === undefined && context?.routineLevel !== true && context?.channelOwner !== true) return false;
  if (hasNoLimits(bot) || !fullAccessCovers(bot, fullAccessOriginOf(context))) return false;
  if (texts.some(text => text !== undefined && wipeShaped(text))) return false;
  // an unplaced link write (`ln -sf x "$d"/h*` with ./h a link to /etc) is a protected write the reader could not place: it keeps its card
  if (hit.unplacedWrite === true) return false;
  // deny = protected + refusals + wipe (Sean 11-10): a path the reader could not bound (doubt value-path) on a system folder
  // or a home path the text computes is a protected path it could not place, so it keeps its card (`cp x /etc/"$X"`, `touch ~/"$X"`)
  if (hit.doubt === "value-path" && texts.some(text => text !== undefined && (SYSTEM_ROOT.test(text) || HOME_COMPUTED.test(text)))) return false;
  // whatever the doubt: when the owner's own read of the text (the read No limits judges by) names a deny and the text names
  // a system folder or computes a home path, it is a protected write nobody placed, not a reader doubt, and keeps its card
  // (`perl -e 'open(my $f, ">", "/etc/cron.d/pwn")'`). A system folder in a read position names no deny and runs
  // (`if; ls /usr`), and so does a deny that names no system folder (`bash -c "$CMD"`, `sh -c "ls $HOME"`). A throw holds.
  try {
    const owner = ownerRead();
    if (owner?.classification === "deny" && texts.some(text => text !== undefined && (SYSTEM_ROOT.test(text) || HOME_COMPUTED.test(text)))) return false;
  } catch { return false; }
  // the key guard is the protected part of deny and stays at Full access: code the reader did not follow that opens a file
  // whose name it computes may read a key the guard cannot see (`open(chr(46)+chr(101)+chr(110)+chr(118))` is .env)
  if (texts.some(text => text !== undefined && COMPUTED_READ.test(text))) return false;
  // a file this session wrote that the command names: its bytes are what runs (r1.4 R-EXEC-3); unavailable or wipe-shaped bytes keep the card
  const edits = context?.readOnlyHooks?.sessionEdits ?? context?.unseen?.sessionEdits;
  const sessionFile = context?.sessionFile ?? context?.unseen?.sessionFile;
  if (edits) for (const path of edits) {
    const name = path.split(/[\\/]/).pop();
    if (!name || !texts.some(text => text?.includes(name))) continue;
    const file = sessionFile?.(path);
    if (!file || file === "unavailable" || wipeShaped(file.text)) return false;
  }
  return noLimitsOnlyVerdict(tool, summary, context).approve !== null;
}

/** A file read whose name is not one plain quoted literal: an open or read call with a computed first argument (bounded,
 * anchored on the call name, so it is linear). */
const COMPUTED_READ = /\b(?:open|fopen|readFile|readFileSync|createReadStream|ReadAllText|ReadAllBytes|ReadAllLines|ReadLines|file_get_contents|Path)\s*\(\s*(?!["'`][^"'`+\n]{0,512}["'`]\s*[,)])(?!\s*\))/i;
/** A system folder named as a path: anything under /etc, /boot, /System, /Library or /private, or /usr, /bin, /sbin, /lib as
 * the folder itself (`/usr`, `/bin/`; a program in it, `/bin/bash`, is a program). */
const SYSTEM_ROOT = /(?:^|[\s"'=(>,:])\/(?:(?:etc|boot|System|Library|private)(?=[\/\s"')]|$)|(?:usr|bin|sbin|lib|lib64)\/?(?=[\s"');&|]|$))/;
const HOME_COMPUTED = /(?:~|\$\{?HOME\}?)\/["']?[$`]/;
/** A shell or exec sink: the text hands something built at run time to a shell or an interpreter to run. */
const SHELL_SINK = /\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:ba|z|da|k)?sh\s+-c\b|\beval\b|\bsource\s+\/dev\/stdin|\bxargs\b[^|;&]*\b(?:ba|z)?sh\b|\b(?:iex|invoke-expression)\b/i;
const EXEC_SINK = /<\(|\$\(|`|\bexec\s*\(|\beval\s*\(|\bsource\s+<|\bFunction\s*\(/i;
/** A decoder: what it prints is text no reader here has decoded (base64, hex, escapes, reversed or rotated letters). */
const DECODER = /\bbase64\b|\bxxd\b|\bopenssl\b|\buudecode\b|\brev\b|\btr\s|\bb64decode\b|\bfromhex\b|\bunhexlify\b|\batob\b|\bfrombase64string\b|\bcodecs\b|\\x[0-9a-f]{2}|\\[0-7]{3}|\\u[0-9a-f]{4}|%b|\b(?:gunzip|zcat|bzcat|xzcat|zstdcat)\b|\bchr\s*\(|\bString\.fromCharCode\b/i;
const DISK_TOOL = /\b(?:mkfs|shred|wipefs|diskutil)|\bof=\/dev\/|-recurse\b|--recursive\b/i;

/** NOLIMITS-1022 H1 (1): a text the reader could not follow still counts as a wipe when, decoded as far as it decodes, the
 * plain wipe check (every byte: `P=rm; $P -rf x`, a device, mkfs, a fork bomb) finds one, its control characters taken out
 * (`$'\u0000rm' -rf ~`), or a recursive forced delete names the home folder or the root. A fault here is a wipe. */
function wipeShaped(text: string): boolean {
  try {
    if (plainWipe(text)) return true;
    // `$IFS` is a space to the shell (`rm$IFS-rf$IFS~`)
    const spaced = text.replace(/\$\{?IFS\}?/g, " ");
    if (spaced !== text && plainWipe(spaced)) return true;
    const sink = SHELL_SINK.test(text) || EXEC_SINK.test(text);
    // text built for a shell to run (`printf '%.2s -rf %.4s' rmX /usrX | sh`): a recursive forced flag or a disk tool in it is a wipe
    if (sink && (DISK_TOOL.test(text) || wordsOf(text).some(recursiveForceWord))) return true;
    // decoded text handed to a shell (`echo cm0g... | base64 -d | sh`, `printf '\x72\x6d ...' | sh`, `exec(b64decode(...))`): nothing
    // here decoded what runs, so neither the wipe check nor the key guard has read it; it keeps its card
    if (sink && DECODER.test(text)) return true;
    // PowerShell's -EncodedCommand (any prefix of it, `-ec`, with `-` or `/`) is base64 UTF-16LE: read what it decodes to
    for (const [, flag, encoded] of text.matchAll(/(?:^|\s)[-/]([a-z]+)[\s:]+["']?([A-Za-z0-9+/=]{4,})/gi)) {
      const name = flag!.toLowerCase();
      if (name !== "ec" && !(name.startsWith("e") && "encodedcommand".startsWith(name))) continue;
      const inner = Buffer.from(encoded!, "base64").toString("utf16le");
      if (plainWipe(inner) || /^\s*(?:rm|ri|rd|del|erase|remove-item)\b/i.test(inner) || wordsOf(inner).some(recursiveForceWord)) return true;
    }
    const decoded = decodeAnsiC(spaced).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    // bash ends a `$'...'` word at its first NUL: `$'rm\0x'` runs rm
    const cut = text.replace(/\$'(?:[^'\\]|\\[\s\S])*'/g, word => decodeAnsiC(word).split("\0")[0]!);
    if ((decoded !== text && plainWipe(decoded)) || (cut !== text && plainWipe(cut))) return true;
    // a recursive forced delete flag on the home folder or the root, whatever program the text names (`$R -rf ~`)
    const words = wordsOf(decoded);
    return words.some((word, at) => recursiveForceWord(word) && at + 1 < words.length && HOME_OR_ROOT.test(words[at + 1]!));
  } catch {
    return true;
  }
}

/** Bounded command admission, recovered from 2888da485c. */
export const COMMAND_READ_MAX_WORK = 16 * 1024;
/** Full access may read at most 128 KiB in one verdict. */
export const COMMAND_GATE_CHARS = 128 * 1024;
/** A here-document only a plain `cat` or `tee` takes costs about a quarter of that per character: no reader runs it. */
const FILE_DATA_SHARE = 4;
const FILE_WRITERS: ReadonlySet<string> = new Set(["cat", "tee"]);
const OVERLONG_NOTE = alwaysAskNote({ ...unreadableHit(), what: "This is longer than Murage reads ahead of running it, so it asks you first." });

/** The read work in one text. It is the length, less three quarters of what a top-level `cat` or `tee` writes from a
 * here-document with nothing in it to expand. A text past what the discount could ever bring under the cap is never
 * parsed here. Any other body counts whole: a shell, an interpreter or a pipe may run it. */
export function commandReadWork(text: string, pwsh: boolean): number {
  if (text.length <= COMMAND_READ_MAX_WORK || pwsh || text.length > COMMAND_READ_MAX_WORK * FILE_DATA_SHARE) return text.length;
  let script: Script;
  try {
    script = parse(text);
  } catch {
    return text.length;
  }
  let work = text.length;
  for (const item of script.items) for (const pipeline of item.andOr.pipelines) {
    const command = pipeline.commands.length === 1 ? pipeline.commands[0]! : undefined;
    if (command?.kind !== "simple" || !isPlainWord(command.words[0], FILE_WRITERS)) continue;
    for (const { heredoc } of command.redirects) {
      if (!heredoc || !(heredoc.quoted || !/[$`\\]/.test(heredoc.body))) continue;
      const { body } = heredoc;
      // the prompt and pin readers still read the body as shell, so what they split or re-read keeps its cost (measured)
      work += Math.ceil(body.length / FILE_DATA_SHARE) - body.length + DATA_RE_READ * (body.match(DATA_RE_READS)?.length ?? 0) + DATA_SPLIT * (body.match(DATA_SPLITS)?.length ?? 0);
    }
  }
  return work;
}
const DATA_RE_READS = /`|[$<>]\(/g;
const DATA_RE_READ = 8;
const DATA_SPLITS = /[|;&]/g;
const DATA_SPLIT = 2;

function isPlainWord(word: Word | undefined, names: ReadonlySet<string>): boolean {
  const part = word?.parts.length === 1 ? word.parts[0] : undefined;
  return part?.kind === "lit" && part.quote === "none" && names.has(part.text);
}

export function autoVerdict(bot: AutoApprover, tool: string, summary: string, context?: AutoContext): AutoVerdict {
  let verdict: AutoVerdict;
  let prior: AutoVerdict | undefined;
  let unlimited=false;
  try{
    const initiator = noLimitsInitiator(bot, context);
    const origin = context?.noLimitsOrigin ?? (context?.fullAccessOrigin === "owner-channel" && context.channelOwner ? "owner-channel" : initiator === 'routine' && context?.unattended !== true ? 'owner-routine' : initiator);
    bot = permissionsForNoLimitsOrigin(origin,bot);
    if(hasNoLimits(bot)&&bot.fullAccessChannelMessages===false&&(origin==='owner-channel'||bot.permissionExplicit===true&&['guest','other-human','other'].includes(origin))){
      const note='Channel messages are off for this bot. Turn them on in the bot’s Settings.';
      console.info('[no-limits] '+note);
      return {approve:null,source:'owner-switch',classification:'deny',rule:'channel-off',note};
    }
    unlimited = noLimitsAppliesTo(origin, bot);
    if (hasNoLimits(bot) && !unlimited) {
      // Guests and unproven turns use the same Ask reader as an Ask bot.
      bot = permissionsForOrigin(bot, false);
    }
  }catch{ /* Unread origin facts retain the existing BASE failure path. */ }
  try {
    if (!unlimited && !context?.shellCwdPrepared && context?.shellCwdByThread && context.threadId && isCommandTool(tool)) {
      rememberShellCwds(context.shellCwdByThread, context.threadId, context.commandText ?? context.exactCommand?.command ?? summary,
        context.commandCwd ?? context.exactCommand?.cwd, process.platform, context.promptFacts?.home);
    }
    prior = unlimited ? noLimitsOnlyVerdict(tool, summary, context) : autoVerdictOf(bot, tool, summary, context);
    verdict = prior;
    if (hasNoLimits(bot)) noLimitsFactsOf.set(verdict, {initiator:noLimitsInitiator(bot,context),n2:verdict.approve===null});
  } catch (error) {
    // 1.0.9 (Sean's log, 10-28): a reader that throws must never drop the
    // request. Thrown out of the approval listener, it raised no card and
    // answered nothing, so the engine waited on a card that never came. A
    // fault here asks, at every level, as an unreadable command does.
    // the ask is set first; the log line is best-effort and never undoes it.
    // The error's own message may carry the command's text: only its kind and where it was thrown
    verdict = unlimited ? noLimitsOnlyVerdict(tool, summary, context) : { approve: null, source: "always-ask", rule: "unreadable", note: alwaysAskNote(unreadableHit()) };
    try {
      console.error(`auto-approve: verdict failed (${error instanceof Error ? error.name : typeof error}), asking${error instanceof Error && error.stack ? `\n${error.stack.split("\n").slice(1, 6).join("\n")}` : ""}`);
    } catch { /* the ask stands */ }
  }
  try { logAsked(bot, tool, verdict, context, prior); } catch { /* the verdict stands */ }
  return verdict;
}

function autoVerdictOf(
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
  // MARKS (MurageMain ruling 11-08, N4): the engine's own explicit command folder is invalid (the engine broke its contract; this is not a
  // reader limit). It never auto-approves at any level or origin: every level gets the typed deny card, no grant or mode answers it.
  // Ahead of the always-ask read, so no other hit changes the card. Synchronous, no await: the interrupt, stop and dispose paths are unchanged.
  if (commandTool && context?.commandCwdInvalid === true) {
    const invalidFolder: AlwaysAskHit = { rule: "unknown-target", classification: "deny", reason: "invalid-command-folder",
      what: "This command would run in a folder Murage could not confirm is this bot's own, so it asks first." };
    return { approve: null, source: "always-ask", rule: invalidFolder.rule, classification: "deny", reason: invalidFolder.reason, note: alwaysAskNote(invalidFolder) };
  }
  // a PowerShell tool's text is PowerShell's, however it starts, and so is
  // the text of a command tool whose driver runs it under PowerShell (Codex
  // and every ACP engine on Windows, `powershell.exe -Command`)
  const shell = isPowerShellTool(tool) || (commandTool && context?.call?.commandShell === "pwsh") ? "pwsh" : undefined;
  const text = context?.commandText ?? context?.exactCommand?.command;
  const carried = resolveCall(context?.call);
  const carriedCommand = commandArgument(carried.kind === "engine" || carried.kind === "mcp" ? carried.input : context?.call?.toolCall?.input);
  const gateParts = [text, summary, carriedCommand];
  const fullRead = fullAccessCovers(bot, fullAccessOriginOf(context));
  if (gateParts.some(part => part !== undefined && (fullRead ? part.length > COMMAND_GATE_CHARS : commandReadWork(part, shell === "pwsh") > COMMAND_READ_MAX_WORK))) {
    const held: AutoVerdict = { approve: null, source: "always-ask", rule: "unreadable", note: OVERLONG_NOTE, reader: "held" };
    readerWhyOf.set(held, "over-length");
    return held;
  }
  // 1.0.9: the HOME the requesting engine's shell was handed, from its own
  // environment record; a `~` in an unseen-script text needs it (always-ask.ts)
  const home = context?.promptFacts?.home;
  // the disk reads of the unseen-script check (tests and the corpus pass a stub)
  const unseen: UnseenOptions = { ...context?.unseen, bashResolve: context?.unseen?.bashResolve ?? context?.handedShellPath, sessionEdits: context?.readOnlyHooks?.sessionEdits ?? context?.unseen?.sessionEdits, sessionFile: context?.sessionFile ?? context?.unseen?.sessionFile };
  // The owner's routine carve-out (1.0.3): on a scheduled or manual routine
  // run, with the engine's own whole command in hand, a write or delete whose
  // target is held in a value does not hold the turn. Everything else the
  // reader finds, and every guard below, holds exactly as for any turn. A
  // webhook, a channel event, host control and the owner's own turns never
  // get here.
  const routineCarve = commandTool && text !== undefined && context?.routineLevel === true && context.routineCarveOut === true && !context.unattended && context.inputCut !== true && context.scope === undefined;
  const windowsBash = shell === "pwsh" && fullAccessOriginOf(context) === "owner" && fullAccessCovers(bot, "owner") ? [] as string[] : undefined;
  // MARKS R1 (MurageMain 11-08): the typed denies and the stricter MARKS reads are the owner's own clean No limits turn only
  // (the same turn `ask` gives the doubt-free relief); every other level and origin reads exactly as at NLH0.
  const ownerMode = hasNoLimits(bot) && !routineCarve && ownerOwnTurn(bot, context);
  const cwd = ownerMode ? (context?.commandCwdInvalid ? "" : context?.commandCwd || context?.exactCommand?.cwd || context?.workFolder) : context?.commandCwd ?? context?.exactCommand?.cwd;
  if (ownerMode) unseen.runtimePaths = context?.runtimePaths;
  // NL-WIN-1018 D4: the pwsh `bash ./x.sh` admission needs the whole clean owner gate; set here and nowhere else
  unseen.pwshOwnerBash = ownerMode && cleanLaneTurn(bot, context) && context?.inputCut !== true && context?.inputTruncated !== true
    && context?.call?.inputMissing === undefined && context?.scope === undefined && context?.routineLevel !== true && context?.commandCwdInvalid !== true;
  // WIN-PWSH-1018 (parity, not relief): Codex and the ACP engines run every Windows command as `powershell -NoProfile -Command
  // <text>`, so their `bash ./build.sh` reached the 1.0.5 launcher rule (pwsh.ts unmodelled: "bash runs something the reader does
  // not see") and carded at Full access with why=tokenizer, where the Claude Bash tool's own `bash ./build.sh` is read by the
  // unseen-script reader and covered (`unseenCovered` below). At the level and origin Full access covers for the owner (the
  // `windowsBash` gate above), the exact D4 text is read as the Git Bash text it is, through that same reader and the same judges
  // (a deny rule on the script's path, placement under the folder, the head bytes, the relayed-scope card); nothing passes here
  // that the Claude Bash tool's text would not. No limits keeps the D4 gate; every other level, origin and spelling reads as before.
  unseen.pwshFullBash = !hasNoLimits(bot) && windowsBash !== undefined && context?.inputCut !== true && context?.inputTruncated !== true
    && context?.call?.inputMissing === undefined && context?.scope === undefined && context?.routineLevel !== true && context?.commandCwdInvalid !== true;
  let catastrophe: AlwaysAskHit | null;
  let valueTarget: CarvedTarget[] | undefined;
  let innerText: string | undefined;
  let waived = false;
  // MARKS r7 (M-R7-level): the closed-list doubts hold owner No limits turns only; every other level reads with them
  // off, as before MARKS. A doubt-free read that fails for any other reason keeps the strict read's verdict.
  const lax = <T>(read: () => T): T => {
    try { return withoutDoubts(read); } catch { return read(); }
  };
  // M-R10-monotonic (MurageMain 11-07): No limits is never stricter than Full access unless a deny rule (a named
  // catastrophe) or the wipe list applies. A closed-list doubt alone is neither, so a card that rests only on a doubt
  // is replaced by what the doubt-free read finds, exactly as Full access reads it, on the owner's own turns.
  const ask = <T>(read: () => T): T => {
    if (!hasNoLimits(bot)) return lax(read);
    // owner turns only: a routine, a channel, a webhook, any unattended No limits turn, and a turn the owner did not start
    // himself (origin "owner" also means a bot his turn reached; MARKS r13, Astra H2) keep the strict read as at NLH0
    if (!ownerMode) return read();
    const strict = ownerMarks(read);
    const hit = (strict && typeof strict === "object" && "hit" in strict ? (strict as { hit: unknown }).hit : strict) as AlwaysAskHit | null;
    return hit && hit.classification !== "deny" && !hit.mandatory && hit.rule === "unreadable" && hit.doubt !== undefined && hit.unseenScript !== true ? ownerMarks(() => lax(read)) : strict;
  };
  const resolvedCall = resolveCall(context?.call);
  // only the card text, cut: what it would run may sit after the cut, so no reader (and no wipe check) has seen it
  const cutSummary = text === undefined && commandTool && approvalSummaryIsCut(summary);
  if (routineCarve) {
    ({ hit: catastrophe, valueTarget } = ask(() => alwaysAskRoutineCommand(text, cwd, shell, home, unseen)));
  } else {
    catastrophe = text !== undefined
      ? ask(() => alwaysAskCommand(text, cwd, "command", shell, windowsBash, home, unseen))
      : commandTool && approvalSummaryIsCut(summary)
        ? unreadableHit()
        : ask(() => alwaysAskCommand(summary, cwd, commandTool ? "command" : "text", shell, windowsBash, home, unseen));
  }
  if (ownerMode) {
    const outer = catastrophe;
    let innerHit: AlwaysAskHit | null = null;
    {
      // A command a wrapper or an MCP tool carries (Fuigo's `use_tool` around the cloud computer's exec) is judged like
      // the engine's own shell tool asking: the card title is the model's, the command inside is what runs.
      // The outer summary never substitutes for the inner command's read.
      const innerCommand = commandArgument(resolvedCall.kind === "engine" || resolvedCall.kind === "mcp" ? resolvedCall.input : context?.call?.toolCall?.input);
      if (innerCommand !== undefined && innerCommand !== text) {
        const inner = ask(() => alwaysAskCommand(innerCommand, cwd, "command", shell, windowsBash, home, unseen));
        innerHit = inner;
        innerText = innerCommand;
      }
    }
    // Each executable component must qualify on its own before any aggregation.
    const normalize = (finding: AlwaysAskHit | null): AlwaysAskHit | null => {
      if (!finding) return null;
      // No limits distinguishes a protected write from legacy path mentions and script reads.
      if (finding.rule === "protected-path") {
        const write = noLimitsProtectedWrite(text ?? summary, context, shell) ?? (innerText !== undefined ? noLimitsProtectedWrite(innerText, context, shell) : null);
        const command = [text ?? summary, innerText ?? ""].join("\n");
        // Archive mode/operand roles are decided by the write reader above.
        const namedWriter = /(?:wipe|nuke|cleanse|zap)|^(?:zip|time|touch|tee|truncate|mv|chmod|chown|install)$/.test(finding.program ?? "");
        return write ?? (namedWriter || /\btime\s+-o\s|\bCopy-Item\s/i.test(command) || plainWipe(command) ? finding : null);
      }
      // Sensitive tooling and read mentions keep no reader card on owner No limits work.
      const componentText = [text ?? summary, innerText ?? ""].join("\n");
      if (finding.rule === "unreadable" && finding.classification !== "deny" && !finding.mandatory && !finding.namedCatastrophe
        && matchFirst(PATH_RULES, componentText) && !plainWipe(componentText)
        && !noLimitsProtectedWrite(text ?? summary, context, shell, true)
        && (innerText === undefined || !noLimitsProtectedWrite(innerText, context, shell, true))) return null;
      // An opaque native call without a protected write keeps the owner run outcome.
      if (finding.rule === "unreadable" && finding.readerFailed && finding.classification !== "deny" && !finding.mandatory && !finding.namedCatastrophe
        && /\b(?:ctypes|cffi|ffi-napi|fiddle|dlopen)\b/i.test(componentText) && !plainWipe(componentText)
        && !noLimitsProtectedWrite(text ?? summary, context, shell, true)
        && (innerText === undefined || !noLimitsProtectedWrite(innerText, context, shell, true))) return null;
      if (finding.classification === "deny" || finding.mandatory) return finding;
      if (finding.unseenScript && context?.scope === "local-computer") return { ...unreadableHit(), unseenWhy: "relayed" };
      const owner = finding.unseenScript && hasNoLimits(bot)
        ? ownerUnseenWaived(bot, context, routineCarve, finding, [text ?? summary, innerText]) : false;
      if (typeof owner === "object") return owner;
      const covered = finding.unseenScript === true
        && (marksHitWaivable(finding) || !hasNoLimits(bot) || owner === true)
        && fullAccessCovers(bot, fullAccessOriginOf(context));
      return covered ? null : finding;
    };
    const findings = [normalize(outer), normalize(innerHit)].filter((hit): hit is AlwaysAskHit => hit !== null);
    catastrophe = structuredProtectedWrite(text ?? summary, context, shell)
      ?? (innerText !== undefined ? structuredProtectedWrite(innerText, context, shell) : null)
      ?? findings.find(hit => hit.classification === "deny") ?? findings.find(hit => hit.mandatory) ?? findings[0] ?? null;
    waived = catastrophe !== null && catastrophe.classification !== "deny" && !catastrophe.mandatory
      && !windowsShellCall(shell, [text ?? summary, innerText])
      && couldNotReadWaived(bot, context, [catastrophe, outer, innerHit], [text ?? summary, ...(innerText !== undefined ? [innerText] : [])]);
    if (waived) logWaived(bot, tool, catastrophe!);
    if (catastrophe && !waived) {
      const reader = catastrophe.rule === "unreadable" ? "held" : undefined;
      const held: AutoVerdict = { approve: null, source: "always-ask", rule: catastrophe.rule,
        classification: catastrophe.classification ?? "ask", reason: catastrophe.reason ?? catastrophe.doubt ?? catastrophe.rule,
        note: alwaysAskNote(catastrophe), ...(reader ? { reader } : {}) };
      if (reader) readerWhyOf.set(held, catastrophe.mandatory ? catastrophe.reason ?? "named" : catastrophe.doubt ?? catastrophe.unseenWhy ?? (catastrophe.unseenScript ? "unseen-script" : catastrophe.readerFailed ? "reader-failed" : "named"));
      if (reader) readerShapeOf.set(held, askShapeOf(text ?? summary));
      return held;
    }
  } else {
    const outer = catastrophe;
    let innerHit: AlwaysAskHit | null = null;
    if (!catastrophe || catastrophe.unseenScript === true || catastrophe.rule === "unreadable") {
      // A command a wrapper or an MCP tool carries (Fuigo's `use_tool` around the cloud computer's exec) is judged like
      // the engine's own shell tool asking: the card title is the model's, the command inside is what runs.
      // An unseen script in the outer text never stands in for that read: whatever the inner command hits wins,
      // unless it too is only an unseen script.
      const innerCommand = commandArgument(resolvedCall.kind === "engine" || resolvedCall.kind === "mcp" ? resolvedCall.input : context?.call?.toolCall?.input);
      if (innerCommand !== undefined && innerCommand !== text) {
        const inner = ask(() => alwaysAskCommand(innerCommand, cwd, "command", shell, windowsBash, home, unseen));
        innerHit = inner;
        innerText = innerCommand;
        if (inner && (!catastrophe || inner.unseenScript !== true)) catastrophe = inner;
      }
    }
    // An unseen script is not proven safe by its shape or the selected mode.
    if (catastrophe?.unseenScript === true && context?.scope === "local-computer") catastrophe = { ...unreadableHit(), unseenWhy: "relayed" };
    // r1.5 2.1: an unseen script admitted by shape holds on No limits; Full access is unchanged (MARKS r7)
    // MARKS r11 (M-R11-unseen): the owner's own No limits turn runs what Full access runs; a script a deny rule names cards by that rule
    // MARKS r13 (Astra H3, MurageMain 11-07): a script whose own path a deny rule names cards by that rule at every level,
    // Full access included (R2: a deny rule holds at every level)
    const deniedScript = catastrophe?.unseenScript === true ? protectedScriptHit(catastrophe.unseenPaths ?? []) : null;
    if (deniedScript) catastrophe = deniedScript; // M-R11-unseen-deny
    const ownerUnseen = catastrophe?.unseenScript === true && hasNoLimits(bot) ? ownerUnseenWaived(bot, context, routineCarve, catastrophe, [text ?? summary, innerText]) : false;
    if (typeof ownerUnseen === "object") catastrophe = ownerUnseen;
    const unseenCovered = catastrophe?.unseenScript === true
      && (marksHitWaivable(catastrophe) || !hasNoLimits(bot) || ownerUnseen === true)
      && fullAccessCovers(bot, fullAccessOriginOf(context));
    // 1.0.22 MAIN-RULING NOLIMITS-1022 H1: on a turn Full access covers, a text the reader could not follow is no reason
    // to ask unless it is wipe-SHAPED; it goes on to the key guard and the grant below like any read text
    if (catastrophe !== null && !unseenCovered && !cutSummary && fullAccessUnreadableRuns(bot, tool, summary, context, catastrophe, [text ?? summary, innerText],
      () => ownerMarks(() => lax(() => alwaysAskCommand(text ?? summary, cwd, commandTool ? "command" : "text", shell, windowsBash, home, unseen))))) catastrophe = null;
    // 1.0.13 (NOLIMITS-MEANS-IT, design section 14): a text the reader could not follow holds at every level, owner
    // No limits included. Hits it holds on carry `readerFailed`.
    // HOOK (NOLIMITS-WIPE-WORD, design R3 and R11): any waiver of such a hit is one check on that mark, here and only here,
    // ahead of this return. It needs `outer` from before the inner read. `inputTruncated` already keeps a cut call's card.
    // The explicit waiver policy is empty. Context checks cannot grant a waiver.
    waived = catastrophe !== null && !unseenCovered
      && !windowsShellCall(shell, [text ?? summary, innerText])
      && couldNotReadWaived(bot, context, [catastrophe, outer, innerHit], [text ?? summary, ...(innerText !== undefined ? [innerText] : [])]);
    // OVERREACH #6 (Sean 2026-11-26): the owner's own Full access turn runs the three rules No limits runs (unreadable, unknown-target,
    // protected-path) when No limits' own wipe check finds nothing; the wipe rules, a deny hit and the key guard below still hold.
    if (!waived && catastrophe !== null && !unseenCovered && !windowsShellCall(shell, [text ?? summary, innerText]) && fullOwnerRunWaives(bot, tool, summary, context, [catastrophe, outer, innerHit])) waived = true;
    if (waived) logWaived(bot, tool, catastrophe!);
    if (catastrophe && !unseenCovered && !waived) {
      // OVERREACH #6: the owner's Full access card for a call No limits cards as a wipe is that wipe card, never a looser or vaguer one
      // (only for a script file the reader did not open and a whole volume: every other held call keeps its own pinned card)
      if (ALWAYS_ASK_NO_LIMITS[catastrophe.rule] === "run" && (catastrophe.unseenScript === true || catastrophe.protectedClass === "volume" || runsWrittenScript(text ?? summary, context)) && !windowsShellCall(shell, [text ?? summary, innerText])) {
        const wipe = fullOwnerNoLimitsAnswer(bot, tool, summary, context);
        if (wipe && wipe.approve === null && wipe.source === "always-ask" && wipe.rule !== undefined && ALWAYS_ASK_NO_LIMITS[wipe.rule as keyof typeof ALWAYS_ASK_NO_LIMITS] === "wipe") return wipe;
      }
      const reader = catastrophe.rule === "unreadable" ? "held" : undefined;
      const held: AutoVerdict = { approve: null, source: "always-ask", rule: catastrophe.rule,
        reason: catastrophe.reason ?? catastrophe.doubt ?? catastrophe.rule,
        note: alwaysAskNote(catastrophe), ...(reader ? { reader } : {}) };
      // APPROVALS-SIMPLE-1018 5 (NOLIMITS-UNREADABLE R6): the asked line says which reader shape still cards, no text
      if (reader) readerWhyOf.set(held, catastrophe.doubt ?? catastrophe.unseenWhy ?? (catastrophe.unseenScript ? "unseen-script" : catastrophe.readerFailed ? "reader-failed" : "named"));
      if (reader) readerShapeOf.set(held, askShapeOf(text ?? summary));
      return held;
    }
  }
  // a carved command is guarded on its whole text too, so a key or a
  // destructive step past the card's cut summary still holds
  const passed = verdictPastAlwaysAsk(bot, tool, summary, context, windowsBash?.length ? [text ?? summary, ...windowsBash].join("\n") : valueTarget !== undefined ? text : undefined, windowsBash);
  // MurageMain (S10 relay 4, 11-06): a run the reader could not follow is logged as that, so the decision log tells it from a normal read
  const verdict = waived && passed.approve && passed.rule === undefined ? { ...passed, rule: "held=waived" } : passed;
  return valueTarget !== undefined && verdict.approve ? { ...verdict, valueTarget } : verdict;
}

/** MurageMain 11-07 (MARKS r11, M-R11-unseen): No limits is never stricter than Full access except on a deny rule or the
 * wipe list, and Full access runs an unseen script file of the allowed shape (`bash ./build.sh`, `node tvcall.mjs`). So
 * the owner's own No limits turn runs it too. A routine, a channel, an unattended, a scoped, a cut or a marked-lane turn
 * keeps the card, and so does a script whose own path a deny rule names (a system folder, a climb, the home or root
 * folder) or a text the wipe list names. */
function ownerUnseenWaived(bot: AutoApprover, context: AutoContext | undefined, routineCarve: boolean, hit: AlwaysAskHit, texts: ReadonlyArray<string | undefined>): boolean | AlwaysAskHit {
  if (hit.classification === "deny" || hit.mandatory || hit.reason === "ambiguous-interpreter") return false;
  if (routineCarve || !ownerOwnTurn(bot, context)) return false; // M-R11-unseen-owner (r13: the owner-started proof, Astra H2)
  if (context?.unattended || context?.automated || context?.channelOwner || context?.routineLevel) return false; // M-R11-unseen-turn
  if (context?.scope !== undefined || context?.inputCut === true || context?.inputTruncated === true) return false;
  if (markedLaneTurn(bot, context)) return false; // M-R11-unseen-lane
  const paths = hit.unseenPaths ?? [];
  if (paths.length === 0) return false;
  return !texts.some((t) => t !== undefined && plainWipe(t)); // M-R11-unseen-wipe
}

/** The card sources a held OWN_ALWAYS_ASK tool is re-named from: those that
 * offer a remembered grant the owner could not use for it. A guard keeps its own name. */
const OWN_ALWAYS_ASK_CARDS: ReadonlySet<AutoVerdictSource> = new Set<AutoVerdictSource>(["no-grant", "stop-line", "unattended-block", "local-computer-block"]);

/** Every mode, grant and guard after the always-ask reader. Rule 51: below
 * Full access, an OWN_ALWAYS_ASK tool (publish_site, take_down_site,
 * skill_manage, skill_switch, ...) is judged with every remembered answer taken away: no
 * "Always allow" (tool, exact command, app action or stop-line place), no task
 * allowance, no routine grant. Auto mode's own answer is the same as for any
 * tool. A card it raises offers no grant (source always-ask); a guard keeps its
 * name. Full access keeps its contract and its grants. */
function verdictPastAlwaysAsk(bot: AutoApprover, tool: string, summary: string, context: AutoContext | undefined, wholeText?: string, windowsBash?: readonly string[]): AutoVerdict {
  const own = fullAccessCovers(bot, fullAccessOriginOf(context)) ? undefined : ownAlwaysAskOf(tool, resolveCall(context?.call), context?.call);
  if (!own) return verdictWithGrants(bot, tool, summary, context, wholeText, windowsBash);
  const ungranted: AutoApprover = { ...bot, alwaysAllow: undefined };
  const stripped: AutoContext | undefined = context && { ...context, taskAllowanceKeys: undefined, stopAllowedForTask: undefined, routineAllow: undefined };
  const verdict = verdictWithGrants(ungranted, tool, summary, stripped, wholeText, windowsBash);
  if (verdict.approve || !OWN_ALWAYS_ASK_CARDS.has(verdict.source)) return verdict;
  return { approve: null, source: "always-ask", rule: `own-always-ask ${own}`, note: OWN_ALWAYS_ASK_NOTE };
}

/** A check that could not start or timed out does not hold a command at Full access or No limits on a turn the owner
 * started, or on a routine's run judged at that level: the owner set the level for the routine, and `routineLevel` says
 * the routine's own level is what `bot` carries here. Nothing else is waived: a channel, webhook or unproven turn holds. */
function envCheckWaived(bot: AutoApprover, context: AutoContext): boolean {
  if (!hasFullAccess(bot)) return false;
  return context.fullAccessOrigin === "owner"
    || (context.fullAccessOrigin === "routine" && context.routineLevel === true && !context.unattended && !context.channelOwner);
}

/** NOLIMITS-MEANS-IT section 2: No limits on a turn the owner started himself, at the app or his paired phone. Stored
 * fields only, never inferred from a missing one: `ownerStarted` is computed fresh at every start and bound to the
 * exact provider turn, because origin `owner` alone also means "a bot the owner's turn reached". */
/** MARKS r13 (Astra H2): the owner's own turn for the doubt-free relief and the unseen-script waiver: ownerNoLimits()'s
 * proof (ownerStarted, origin owner, attended, not automated, not a routine), and not a channel. */
function ownerOwnTurn(bot: AutoApprover, context: AutoContext | undefined): boolean {
  return ownerNoLimits(bot, context) && context?.channelOwner !== true;
}

export function ownerNoLimits(bot: AutoApprover, context: AutoContext | undefined): boolean {
  return hasNoLimits(bot) && context?.ownerStarted === true && context.fullAccessOrigin === "owner"
    && !context.unattended && !context.automated && !context.routineLevel;
}

/** Legacy lower-level policy (section 1, r3): the lane predicate. Relief (2) and the marked-turn rule (6) use it. */
export function laneApplies(bot: AutoApprover, context: AutoContext | undefined): boolean {
  return ownerNoLimits(bot, context) && context?.noPreRunSeamAtNoLimits !== true;
}

/** Legacy lower-level policy, MurageMain ruling 3 (11-06): on Windows, PowerShell and cmd commands keep TODAY's behaviour
 *  at No limits (fail closed, the same no-regression exception as OpenClaw): neither the could-not-read waiver (2.1) nor
 *  the gate-file relief (2.3) applies. A call is a Windows shell call when its dialect is PowerShell (a PowerShell tool,
 *  or a driver that runs commands under it), or when any of its texts names cmd or PowerShell as a word anywhere. Words
 *  only over-match in this legacy BASE reader. Admitted No limits calls use the wipe-only path above. */
const WINDOWS_SHELL_WORD = /(?:^|[\s;&|(){}\\/=])(?:cmd|powershell|pwsh)(?:\.exe)?(?=$|[\s;&|(){}\\/])/i;
export function windowsShellCall(dialect: string | undefined, texts: ReadonlyArray<string | undefined>): boolean {
  return dialect !== undefined || texts.some((text) => text !== undefined && WINDOWS_SHELL_WORD.test(text));
}

/** 6.1: a lane turn that is not stated clean. Absent `outsideRead` is a marked turn (fail closed). */
export function markedLaneTurn(bot: AutoApprover, context: AutoContext | undefined): boolean {
  return laneApplies(bot, context) && context?.outsideRead !== null;
}

/** Note N (design 11, en). The source is a fixed mark name, never text from the call. */
export function outsideTurnNote(source: OutsideMark | OutsideSource | undefined): string {
  return `This chat read outside content (${source ?? "not checked"}), so Murage asks before running this. Allow to run it.`;
}

/** C1 + C2: a lane turn the server stated clean. Absent `outsideRead` is a marked turn. */
function cleanLaneTurn(bot: AutoApprover, context: AutoContext | undefined): boolean {
  return laneApplies(bot, context) && context?.outsideRead === null;
}

/** No parser rejection proves a command safe, regardless of the lane. */
export function marksHitWaivable(hit: AlwaysAskHit): boolean {
  // D4 as corrected (NOLIMITS-MEANS-IT r3 2.1.1) and FIX A ruling 2: only the two could-not-read findings with no guessed path are
  // waivable (owner No limits, clean turn, no plainWipe); no other parser rejection proves a command safe (M-FIX2-waiver)
  return hit.classification === "ask" && hit.couldNotRead === true && COULD_NOT_READ_FINDINGS.has(hit.reason ?? "");
}

/** Keep the context checks, but require explicit admission for each hit. */
function couldNotReadWaived(bot: AutoApprover, context: AutoContext | undefined, hits: ReadonlyArray<AlwaysAskHit | null>, texts: readonly string[]): boolean {
  if (!cleanLaneTurn(bot, context) || !ownerOwnTurn(bot, context)) return false; // the owner's own turn (not a channel turn)
  if (context!.inputCut === true || context!.inputTruncated === true || context!.call?.inputMissing !== undefined || context!.scope !== undefined) return false;
  if (!hits.every((hit) => hit === null || marksHitWaivable(hit))) return false;
  return !texts.some((t) => plainWipe(t));
}

/** OVERREACH #6: the owner's own turn at Full access (not No limits): started by the owner, attended, not a routine or channel turn. */
function fullOwnerOwnTurn(bot: AutoApprover, context: AutoContext | undefined): boolean {
  return hasFullAccess(bot) && !hasNoLimits(bot) && context?.ownerStarted === true && context.fullAccessOrigin === "owner"
    && !context.unattended && !context.automated && !context.routineLevel && context.channelOwner !== true;
}

/** OVERREACH #6: the text runs a script this session wrote (the one case where the wipe check reads a file). */
function runsWrittenScript(text: string, context: AutoContext | undefined): boolean {
  try {
    const edits = context?.readOnlyHooks?.sessionEdits ?? context?.unseen?.sessionEdits;
    if (!edits || edits.size === 0) return false;
    return writtenScriptRuns(text, { sessionEdits: edits, cwd: context?.commandCwd ?? context?.exactCommand?.cwd ?? context?.workFolder }, context?.promptFacts?.home ?? "").length > 0;
  } catch { return false; }
}
/** OVERREACH #6: No limits' own answer for a whole call on the owner's own Full access turn (not scoped to the computer, not cut); null
 * otherwise. Full access shows the card this answer is when it is a wipe (a script body that deletes the home folder, a whole volume, a
 * script body that cannot be read), whatever reader rule held the call first; it never shows a looser one. */
function fullOwnerNoLimitsAnswer(bot: AutoApprover, tool: string, summary: string, context: AutoContext | undefined): AutoVerdict | null {
  if (!fullOwnerOwnTurn(bot, context)) return null;
  if (context!.inputCut === true || context!.inputTruncated === true || context!.call?.inputMissing !== undefined || context!.scope !== undefined) return null;
  return noLimitsOnlyVerdict(tool, summary, context);
}
/** OVERREACH #6: a hit of the three ALWAYS_ASK_NO_LIMITS "run" rules is waived on the owner's own Full access turn, exactly as No limits
 * runs it, when No limits' wipe check finds nothing and no hit is a deny, mandatory or named catastrophe. */
function fullOwnerRunWaives(bot: AutoApprover, tool: string, summary: string, context: AutoContext | undefined, hits: ReadonlyArray<AlwaysAskHit | null>): boolean {
  if (!hits.every((hit) => hit === null || (ALWAYS_ASK_NO_LIMITS[hit.rule] === "run" && hit.classification !== "deny" && !hit.mandatory && !hit.namedCatastrophe))) return false;
  return fullOwnerNoLimitsAnswer(bot, tool, summary, context)?.approve != null;
}

/** Ask log for a waived hit: fixed names only, the reader's rule (a fixed string), never command text. */
function logWaived(bot: AutoApprover, tool: string, hit: AlwaysAskHit): void {
  try {
    const botId = bot.id && /^[\w-]{1,128}$/.test(bot.id) ? bot.id : "unknown";
    const toolName = /^[a-zA-Z][\w.:-]{0,127}$/.test(tool) ? tool : "unknown";
    const why = /^[\w -]{1,64}$/.test(hit.rule) ? hit.rule.replace(/ /g, "-") : "unreadable";
    console.info(`approvals: waived bot=${botId} tool=${toolName} level=no-limits owner=1 held=waived why=${why}`);
  } catch { /* the verdict stands */ }
}

/** Who started this turn, as Full access reads it. */
function fullAccessOriginOf(context: AutoContext | undefined): FullAccessOrigin {
  if (context?.routineLevel && !context.unattended && !context.channelOwner) return "routine";
  if (context?.fullAccessOrigin) return context.fullAccessOrigin;
  return context?.unattended || context?.automated
    ? context.channelOwner === true ? "owner-channel"
      : context.routineLevel === true && !context.unattended ? "routine" : "other"
    : "owner";
}

/** One text for the key guard: as bash hands it on, or its quote-stripped copy when the lexer cannot read it (which can
 * only hold more). */
function dequotedRead(part: string): { text: string; globText: string; homeGlob?: string } {
  return dequotedShellText(part) ?? rawDequotedText(part);
}

/** File-edit tools whose cut part is the file's content, not a path (1.0.10 A3). */
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "multiedit", "notebookedit"]);
/** The cut markers a driver writes into a value it shortened. */
const CUT_MARK = /…\[\d+ bytes more\]|\[truncated/;

/** 1.0.10 (NOLIMITS-CARDS 1C/A3): a cut call whose cut part cannot be a path this computer reads. */
function cutCallReadable(tool: string, context: AutoContext | undefined, resolved: ResolvedCall): boolean {
  if (isCommandTool(tool)) return false;
  // (b) Murage's own connected-apps workbench, on its proven own mount
  if (resolved.kind === "mcp" && resolved.own && /(?:^|_)REMOTE_WORKBENCH$/i.test(resolved.tool)) return true;
  // (a) a file edit (the engine's own edit tools, an ACP edit) with no command field, whose path field was read whole;
  // never an MCP tool, whatever it is called
  if (resolved.kind === "mcp" || resolved.kind === "unproven" || /^mcp__/i.test(tool)) return false;
  const name = resolved.kind === "engine" ? resolved.name.toLowerCase() : bareToolName(tool);
  const edit = FILE_EDIT_TOOLS.has(name) || FILE_EDIT_TOOLS.has(bareToolName(tool)) || context?.call?.toolKind === "edit";
  if (!edit) return false;
  const input = resolved.kind === "engine" ? resolved.input : context?.call?.toolCall?.input;
  if (commandArgument(input) !== undefined) return false;
  const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  const path = body ? ["file_path", "path", "notebook_path"].map((key) => body[key]).find((value) => typeof value === "string" && value.trim()) as string | undefined : undefined;
  if (path !== undefined) return !CUT_MARK.test(path);
  return (context?.realPaths?.length ?? 0) > 0;
}

const SENSITIVE_PATH_SOURCES: ReadonlySet<string> = new Set(PATH_RULES.map((re) => re.source));

/** The one command every text of a bash call agrees on, its card text a copy of it. A bash call's own command tool only;
 * a wrapper or an MCP tool carrying a command keeps the whole read. */
function oneCommand(tool: string, summary: string, resolved: ResolvedCall, texts: ReadonlyArray<string | undefined>): string | undefined {
  if (!isCommandTool(tool) || isPowerShellTool(tool)) return undefined;
  if (resolved.kind !== "unstamped" && !(resolved.kind === "engine" && !resolved.wrapped)) return undefined;
  const shown = summary.trim();
  const commands = new Set(texts.filter((text): text is string => text !== undefined).map((text) => text.trim()));
  if (commands.size > 1) return "\0unmodeled";
  const command = [...commands][0] ?? (approvalSummaryIsCut(shown) ? undefined : shown);
  if (command === undefined) return "\0unmodeled";
  const body = approvalSummaryIsCut(shown) ? shown.replace(/…\[truncated, \d+ characters more\]$/, "") : undefined;
  if (shown !== command && !shown.includes(command) && !(body !== undefined && command.startsWith(body))) return "\0summary";
  return command;
}

/** D3 on a covered bash call. */
function coveredCommandRead(tool: string, summary: string, resolved: ResolvedCall, texts: ReadonlyArray<string | undefined>): CommandDataRead | "plain" | "unmodeled" | "summary" | undefined {
  const command = oneCommand(tool, summary, resolved, texts);
  if (command === undefined) return undefined;
  if (command.startsWith("\0")) return command.slice(1) as "unmodeled" | "summary";
  return splitCommand(command);
}

/** Every string of a command call other than the command and its model-written description: a `cwd` field names a place. */
function coveredOtherStrings(resolved: ResolvedCall, call: GrantCall | undefined): string[] {
  const input = resolved.kind === "engine" ? resolved.input : call?.toolCall?.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.entries(input).filter(([key]) => !["command", "cmd", "script", "code", "description"].includes(key)).map(([, value]) => placeArgumentScan(value).text);
}

function verdictWithGrants(bot: AutoApprover, tool: string, summary: string, context: AutoContext | undefined, wholeText?: string, windowsBash?: readonly string[]): AutoVerdict {
  // Full access raises almost no card — not the destructive guard, not the
  // host-control guard — for a turn the owner started. It still stops at the
  // stop line and the key guard (below). A turn started by a webhook, a
  // channel event or a routine carries input someone else wrote (or nobody is
  // watching it), so it is judged exactly as Auto would judge it. The owner's
  // own channel message joins the owner's turns only when the bot's option
  // says so.
  const origin = fullAccessOriginOf(context);
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
  const commandParts = [context?.exactCommand?.command, innerCommand, wholeText].filter((part): part is string => part !== undefined);
  const promptText = commandParts.length ? commandParts.join("\n") : isCommandTool(tool) ? summary : undefined;
  // Section 11 D2: PowerShell's own spellings (`$env:PAGER='x'`, `Set-Item env:GIT_EDITOR`, ...) on a PowerShell tool and on a
  // command a driver runs under PowerShell (Codex and the ACP engines on Windows)
  const pinShell = isPowerShellTool(tool) || (isCommandTool(tool) && context?.call?.commandShell === "pwsh") ? "pwsh" : undefined;
  const pinUnknown = promptText === undefined ? null : pinOverrideIn(promptText, context?.handedPins ?? NO_PINS, pinShell) ?? windowsBash?.map(payload => pinOverrideIn(payload, context?.handedPins ?? NO_PINS)).find(Boolean) ?? null;
  const unread = context?.envUnread ? `${U20_WORDS}: ${context.envUnread}`
    : context?.envUnchecked && !envCheckWaived(bot, context) ? `${U20_WORDS}: ${context.envUnchecked.reason === "launch-failed" ? "Murage could not start the shell to check its environment" : "the environment check took too long"}`
    : pinUnknown ? `${U19_WORDS}: ${pinUnknown}`
    // 1.0.10 (NOLIMITS-CARDS 1C, narrowed by A3): at Full access and No limits, on a turn they cover, a cut call is not
    // held for what nobody read only where the cut part cannot be a path this computer reads: a file edit whose path
    // was read whole (the cut part is the file's content), and Murage's own connected-apps workbench (its code runs in
    // the Flux sandbox, never here). The key guard below still reads every part it has. No grant is ever made from a
    // cut call (approvalKey, actionGrantRead). Every other cut call, any command, and `scan.cut` keep the hold.
    : context?.call?.truncated && !(fullAccessCovers(bot, origin) && cutCallReadable(tool, context, resolved)) ? "the call was cut before it could be checked"
    : scan.cut ? "the call's arguments run past what the key guard reads"
    : resolved.kind === "unproven" ? `the tool this runs cannot be proven: ${resolved.why}`
    : grantRead?.unread ? `Murage could not read every action in this call: ${grantRead.unread}`
    : contract.ok ? null
    : `the call does not carry what this tool needs (${contract.field})`;
  const keyText = [guarded, scan.text, ...(context?.realPaths ?? [])].join("\n");
  // NOLIMITS-KEY-TEXT (design section 14): on a turn Full access or No limits covers, a known file tool's fields are read
  // by role (B1) and a modeled bash line's echo and printf operands leave the path rows (D3). Never at Ask or Auto, never for a
  // PowerShell text (3.6), an MCP or unproven tool: those keep the whole read.
  const covered = fullAccessCovers(bot, origin) && context?.fullAccessOrigin !== "other";
  const fields: FileToolRead | undefined = covered ? fileToolRead(tool, context?.call, resolved, summary) : undefined;
  const commandData: CommandDataRead | "plain" | "unmodeled" | "summary" | undefined = covered && pinShell !== "pwsh" && !windowsBash?.length ? coveredCommandRead(tool, summary, resolved, [context?.exactCommand?.command, innerCommand, wholeText, context?.commandText]) : undefined;
  const dataRead = typeof commandData === "object" ? commandData : undefined;
  // Option B: known placement only adds candidates to the unchanged judgement.
  const placedGlobRead = (text: string): string | null => {
    // X3 r5 section 1: on a prepared call the verdict layer's glob read is b18's
    // `globKeyRead`, exactly. X3's own finding arrives only as globExpansionRule.
    // Unprepared calls (file-tool glob fields) keep head behaviour [F7].
    // Eligible No limits calls return before this BASE policy is reached.
    if (context?.shellCwdPrepared) return legacyGlobKeyRead(text);
    const command = isCommandTool(tool) || commandParts.length > 0 || wholeText !== undefined;
    // X3 intersections read lexer operands, never parameter syntax as a filename.
    const words = command ? shellGlobWords(text, { shell: pinShell }).map(word => word.token) : [text];
    const cwd = context?.commandCwd ?? context?.exactCommand?.cwd;
    const state = context?.threadId ? context.shellCwdByThread?.get(context.threadId) : undefined;
    for (const word of words) {
      const direct = globKeyRead(word);
      if (direct) return direct;
      // A cd only places actual operands; entering /etc does not read /etc/profile.
      for (const place of [cwd, ...cdOperands(text)].filter((place): place is string => !!place)) {
        const folder = homeForm(place, process.platform, context?.promptFacts?.home);
        if (/[$`%]/.test(folder)) continue;
        for (const joined of placedGlobs(word, folder)) {
          const hit = matchFirst(SENSITIVE, joined) ?? globKeyRead(joined);
          if (hit) return hit;
        }
      }
      if (state) {
        for (const [target, earlier] of state.targets) for (const joined of placedGlobs(word, target)) {
          const hit = matchFirst(SENSITIVE, joined) ?? globKeyRead(joined);
          if (hit) return `${hit} (${earlier})`;
        }
        if (state.unknown) {
          const hit = unknownShellGlobRead(word);
          if (hit) return `${hit} (${state.unknown}; shell cwd unknown)`;
        }
      }
    }
    return null;
  };
  const cdFolderRead = (): string | null => {
    for (const operand of cdOperands([guarded, context?.commandText ?? ""].join("\n"))) {
      const folder = homeForm(operand, process.platform, context?.promptFacts?.home);
      const hit = matchFirst(PATH_RULES, folder.replace(/[\\/]$/, "") + "/")
        ?? (isGlobWord(folder) && !/[$`%]/.test(folder) ? globKeyRead(`cd ${folder}`) : null);
      if (hit) return hit;
    }
    return null;
  };
  // the file tool's own read: every path field and real path by the kind's rows, a glob field as a glob, no content
  const fieldHit = (read: FileToolRead): string | null => {
    for (const text of [...read.paths, ...(context?.realPaths ?? []), ...(read.summaryRead ? [summary] : [])]) {
      const hit = matchFirst(read.read ? readKindRules(text) : SENSITIVE, text);
      if (hit) return hit;
    }
    for (const glob of read.globs) {
      const hit = matchFirst(SENSITIVE, glob) ?? placedGlobRead(glob);
      if (hit) return hit;
    }
    return null;
  };
  // 3.5: a Read of a tooling place keeps no hold of the engine's own, by exact row id, when the same read passes the path
  const holdDropped = fields?.read === true && context?.localHold !== undefined && isReadPassHold(context.localHold) && fieldHit(fields) === null;
  const localHold = context?.localHold && !holdDropped ? `${LOCAL_HOLD_WORDS} (${context.localHold})`
    : context?.realPathCannot ? `${REAL_PATH_WORDS} (${context.realPathCannot.slice(0, 200)})` : null;
  // 09-1: a glob in the command text that could match a key file
  // (`cat ~/.aw?/credentials`, `Get-Content ~\.aws\cred*`) is a read of it
  const commandGlobText = isCommandTool(tool) || commandParts.length || wholeText !== undefined ? [isCommandTool(tool) ? summary : "", ...commandParts, wholeText ?? "", context?.commandText ?? ""].join("\n") : "";
  // 1.0.7: the same rows over the command as bash hands it on (quotes removed, braces multiplied out), and a glob
  // or brace that picks a home folder entry, which no reader can name
  const dequoted = (pinShell === "pwsh" && !windowsBash?.length || !commandGlobText.trim()) ? undefined : (() => {
    // each text on its own: a card summary cut mid-quote must not hide the engine's whole command
    // 1.0.10: a text the lexer cannot read meets the rows as its quote-stripped copy; substitutions nested past the
    // reader's depth still hold at every level, as in 1.0.9 (the fix round's depth fallback went with 1B to 1.0.11)
    const reads = (pinShell === "pwsh" ? windowsBash ?? [] : [isCommandTool(tool) ? summary : "", ...commandParts, wholeText ?? "", context?.commandText ?? ""]).filter((part) => part.trim()).map((part) => dequotedRead(part));
    const read = reads.filter((one): one is NonNullable<typeof one> => one !== undefined);
    return read.length ? { text: read.map((one) => one.text).join("\n"), globText: read.map((one) => one.globText).join("\n"), homeGlob: read.find((one) => one.homeGlob)?.homeGlob } : undefined;
  })();
  const rowHit = (): string | null => fields ? fieldHit(fields)
    : dataRead ? matchFirst(PATH_RULES, [dataRead.paths, ...coveredOtherStrings(resolved, context?.call), ...(context?.realPaths ?? [])].join("\n")) ?? matchFirst(TEXT_RULES, keyText)
    // a modeled command's description is the model's own words about it, never run: read for values, not paths
    : commandData === "plain" ? matchFirst(PATH_RULES, [guarded, ...coveredOtherStrings(resolved, context?.call), ...(context?.realPaths ?? [])].join("\n")) ?? matchFirst(TEXT_RULES, keyText)
    : matchFirst(SENSITIVE, keyText);
  const dequotedHit = (): string | null => !dequoted ? null
    : (dataRead ? matchFirst(TEXT_RULES, dequoted.text) ?? placedGlobRead(dataRead.globs) : matchFirst(SENSITIVE, dequoted.text) ?? placedGlobRead(dequoted.globText)) ?? (dequoted.homeGlob ? `${dequoted.homeGlob}${HOME_GLOB_WORDS}` : null);
  // A10: a key's value in any string, at every level, whatever else the call is
  const shapeHit = (): string | null => keyValueShapeIn(keyText) ?? (dequoted ? keyValueShapeIn(dequoted.text) : null);
  const keyHit = (): string | null => unread ?? localHold ?? context?.globExpansionRule ?? rowHit() ?? cdFolderRead() ?? shapeHit() ?? (dataRead ? null : placedGlobRead(commandGlobText)) ?? dequotedHit();
  const sensitive = destructive ? null : keyHit();
  const sensitiveSource: AutoVerdictSource = unread ? "unread-call" : "sensitive-guard";
  const keyHeld = (rule: string): AutoVerdict => {
    const verdict: AutoVerdict = { approve: null, source: sensitiveSource, rule };
    if (!unread) keyWhyOf.set(verdict, context?.localHold && rule.startsWith(LOCAL_HOLD_WORDS) ? "local-hold"
      : resolved.kind === "mcp" || resolved.kind === "unproven" ? "mcp"
      : pinShell === "pwsh" ? "pwsh"
      : fields ? "field"
      : commandData === "unmodeled" || commandData === "summary" ? commandData
      : SENSITIVE_PATH_SOURCES.has(rule) ? "path" : "value");
    return verdict;
  };
  // The stop line outranks every mode, Full access included: deleting
  // outside its folder, paying, and messaging someone new wait for the
  // owner. Only a grant scoped to the same place answers it — the owner's
  // "Allow for this task", or an "Always allow" keyed by folder, payee or
  // recipient (never the bare tool name, which is why an older `Bash:rm` or
  // `mcp__stripe__create_charge` grant cannot reach it). A turn nobody is
  // at uses neither: it holds the card, as every other unattended grant does.
  // No limits lifts the stop line for exactly the turns Full access covers;
  // a webhook, routine or someone else's turn is judged as before (1.0.10 A5
  // was cut: routine runs keep the 1.0.9 stop line).
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
    if (keyGuard) return keyHeld(keyGuard);
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
    if (keyGuard) return keyHeld(keyGuard);
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
  // permanent and unrecoverable. No limits on a turn the owner started is the
  // one exception, below: he read and accepted that in the warning.
  if (fullAccessCovers(bot, origin)) {
    // FULL-DENY-1018: a protected file spelled with `./`, `//`, empty or `x/../` segments is the same file at every level
    const keyGuard = sensitive ?? (destructive ? keyHit() : null) ?? gateHitSpelled([keyText, rawDequotedText(keyText, pinShell === "pwsh").text, ...(dequoted ? [dequoted.text] : [])]);
    // No limits on a turn the owner started keeps only the gate files of the key guard: a call naming one still asks,
    // and everything else the guard holds runs and is recorded by its fixed name. The gate runs with no key hit too,
    // since the rows read path spellings the key rows do not (`~/.kube/./config`). Every other turn keeps the whole guard.
    if (hasNoLimits(bot) && ["owner", "routine", "owner-channel"].includes(noLimitsInitiator(bot, context))) {
      const gateTexts = [keyText, rawDequotedText(keyText, pinShell === "pwsh").text, ...(dequoted ? [dequoted.text] : [])];
      const gate = gateHit(gateTexts);
      // S1-B3: only write targets retain the protected-path hold. A read, a mention,
      // or running tooling does not become a write because its text names a gate file.
      const executable = [context?.commandText, ...commandParts].filter((part): part is string => part !== undefined);
      if (!executable.length && isCommandTool(tool)) executable.push(summary);
      const write = executable.map(command => noLimitsProtectedWrite(command, context, pinShell, true)).find(hit => hit?.program !== undefined);
      const fileWrite = fields?.read === false || /^(?:Write|Edit|MultiEdit|NotebookEdit|write|edit)$/.test(tool);
      const filePaths = [...(fields?.paths ?? []), ...(context?.realPaths ?? []), ...(fields ? [] : [scan.text, summary])];
      const fileGate = fileWrite ? gateHit(filePaths) ?? matchFirst(PATH_RULES, filePaths.join("\n")) ?? localHold : null;
      if (write || fileGate) return { approve: null, source: "sensitive-guard", rule: fileGate ?? write?.program ?? "protected-path", classification: "deny", reason: "protected-path" };
      // Completeness handling is retained here; it is independent of path matching.
      if (context?.inputTruncated === true || context?.call?.inputMissing !== undefined) return { approve: null, source: "unread-call", rule: unread ?? "the call was cut before it could be checked" };
      if (gate && cleanLaneTurn(bot, context)) return { approve: `auto-approved ${tool} (no limits)`, source: "no-limits", rule: `held=gate:${ruleRowId(gate) ?? "row"}` };
      const held = keyGuard ? askHeldClass({ approve: null, source: sensitiveSource, rule: keyGuard }) : undefined;
      return { approve: `auto-approved ${tool} (no limits)`, source: "no-limits", ...(held ? { rule: `held=${held}` } : {}) };
    }
    if (keyGuard) return keyHeld(keyGuard);
    if (hasNoLimits(bot)) return { approve: `auto-approved ${tool} (no limits)`, source: "no-limits" };
    return { approve: `auto-approved ${tool} (full access)`, source: "full-access" };
  }
  // The prompt-capable hold (above). The guards keep their names, and so
  // does the unattended block when a grant would have answered.
  if (promptHeld) {
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return keyHeld(sensitive);
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
  if (context?.ownFileRead === true && !destructive && !sensitive && !context.scope) {
    return { approve: `auto-approved ${tool} (its own files)`, source: "own-files" };
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
  // neither table (shared/own-servers.ts asserts it), so they keep asking.
  // Murage's own computer mount, a call that only looks at the screen
  // (OWN_COMPUTER_READS): no card at any level, host-scoped included, the
  // same on every engine. Only for a call proved on this turn's own mount
  // (never a title), behind the guards above; a click, a key or typing keeps
  // its level's rules below and asks at Ask.
  // Not on an unattended host turn: nobody is at the desk and the payload is someone else's, so even a look at the
  // owner's real screen keeps the unattended block below (no grant, a card) like every other host action.
  if (!destructive && !sensitive && !(context?.unattended && context.scope === "local-computer") && resolved.kind === "mcp" && resolved.provenance === "own" && isOwnComputerRead(resolved.mountId, resolved.tool)) {
    return { approve: `auto-approved ${resolved.name} (looks at the screen)`, source: "own-unasked", rule: `${resolved.mountId}/${resolved.tool}` };
  }
  if (!destructive && !sensitive && !context?.scope && resolved.kind === "mcp" && resolved.provenance === "own") {
    const app = resolved.own ? ownAppTool(`mcp__${CONNECTED_APPS_SERVER}__${resolved.tool}`) : undefined;
    // A connected-app lookup is a read on an ordinary turn. On a routine's own run the four lookups are what the
    // routine remembers (Rule 76a): each is answered only by its own saved key (the routine grants, below), so a
    // remembered search never answers a schema read or any other lookup.
    const read = app !== undefined ? APP_LOOKUPS[app] !== undefined && context?.routineLevel !== true : isOwnQuiet(resolved.mountId, resolved.tool)
      // CODEX-WEB-1020: own web_search on the free default provider is a read of the public web with no card at any level
      // (the same answer the Codex hook gives); on a paid provider this is false and the always-ask card stands
      || ownWebSearchRunsUnasked(resolved.mountId, resolved.tool);
    // a handler-carded own tool (bot email's send tools) reaches its handler at every level: the handler applies the bot's email setting and
    // holds on Murage's own card, so no engine card stands in front of it (BOT-EMAIL-MURAGE-109 3.2)
    if (read || (app === undefined && isOwnHandlerCarded(resolved.mountId, resolved.tool)) || (bot.autoApprove && isOwnUnasked(resolved.mountId, resolved.tool))) {
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
export interface CredentialGlobFs {
  realpath(path: string): Promise<string>;
  opendir(path: string): Promise<{
    read(): Promise<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean } | null>;
    close(): Promise<void>;
  }>;
}
/** X3 r5 sections 3-4: how one glob word's listing ended at one place.
 * The ONE typed value the place loop reads from `expandCredentialGlob`.
 * - "witness": a real expansion is a key file (or a key directory read by a
 *   reader), r5 (W). `witness` is the expanded path, `rowId` its row.
 * - "listed": every step was read; no witness. Quiet.
 * - "absent": only ENOENT/ENOTDIR branches were dropped; no witness. Quiet.
 * - "cannot": a step really could not be read (`code`: EACCES, EPERM, EIO,
 *   ELOOP, ..., "timeout", "saturated", "queue", "visited", "entries",
 *   "home", "cwd", "platform", "syntax"). `cards` is true iff a frontier
 *   pair could hold a key under the threshold-1 rule, r5 (C).
 * - "budget": the shared 65,536-step matching budget ran out; cards with
 *   the one "file patterns could not be checked in time" card.
 * `cards` is the only field the loop needs to decide; `rule` is the hold
 * reason text when it cards, else null. `steps` is what this call charged. */
export interface CredentialGlobOutcome {
  kind: "witness" | "listed" | "absent" | "cannot" | "budget";
  cards: boolean;
  rule: string | null;
  witness: string | null;
  rowId: string | null;
  code: string | null;
  steps: number;
  /** Literal and real spellings of every observed protected expansion (bounded by the entry cap). */
  witnessPaths?: readonly string[];
}
/** One matching-step budget per command (r5 section 3), shared by every
 * expansion, place and frontier check of that command. Pass the same object
 * to every `expandCredentialGlob` call of one command. */
export interface GlobStepBudget { used: number; readonly limit: number }
export const GLOB_STEP_LIMIT = 65_536;
export const newGlobStepBudget = (): GlobStepBudget => ({ used: 0, limit: GLOB_STEP_LIMIT });
/** One lexer glob word (r5 section 2) with what the judge needs about the
 * command it sits in: `reader` false only for a bare name-only enumerator
 * (r5 section 1 [S1]); `dotMatch` true when `*`/`?`/`[..]` may match a
 * leading dot (PowerShell, cmd, dotglob). */
export interface GlobWord { token: string; reader: boolean; dotMatch: boolean }
export { shellGlobWords };
export interface CredentialGlobResult {
  available: boolean;
  witness: string | null;
  rule: string | null;
  textFallback: boolean;
  reason?: string;
  outcome: CredentialGlobOutcome;
}

// Shared across requests and both directory mechanisms. A timed out caller
// releases no slot: the underlying operation and its cleanup must settle.
// X3 r5 section 3: a saturated pool WAITS for a slot inside the same
// deadline; a slot not won by the deadline is a timeout.
const pathAdmissions = new Set<Promise<unknown>>();
const PATH_ADMISSIONS = 8;
async function admittedPathIO<T>(work: () => Promise<T>, deadline: number): Promise<{ value: T } | { reason: string }> {
  while (pathAdmissions.size >= PATH_ADMISSIONS) {
    if (performance.now() >= deadline) return { reason: "timeout" };
    let wait: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.race([...pathAdmissions]).then(() => undefined, () => undefined),
      new Promise<void>(resolve => { wait = setTimeout(resolve, Math.max(0, deadline - performance.now())); }),
    ]);
    if (wait !== undefined) clearTimeout(wait);
  }
  if (performance.now() >= deadline) return { reason: "timeout" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve().then(work);
  pathAdmissions.add(pending);
  void pending.then(() => pathAdmissions.delete(pending), () => pathAdmissions.delete(pending));
  const result = await Promise.race([
    pending.then(value => performance.now() < deadline ? { value } : { reason: "timeout" }, () => ({ reason: performance.now() >= deadline ? "timeout" : "unreadable" })),
    new Promise<{ reason: string }>(resolve => { timer = setTimeout(() => resolve({ reason: "timeout" }), Math.max(0, deadline - performance.now())); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

/** The one card a command gets when its matching budget runs out (r5 section 3). */
export const GLOB_BUDGET_WORDS = "file patterns could not be checked in time";
class GlobBudgetSpent extends Error {}
class GlobDeadline extends Error {}
/** r5 section 4: ENOENT and ENOTDIR are ABSENT (that branch holds nothing). Every other code is CANNOT. */
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);
const ioCode = (error: unknown): string => {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code ? code : "EUNKNOWN";
};
/** One step of the shared per-command matching budget. The counter never passes its limit. */
export function chargeGlobStep(budget: GlobStepBudget): () => void {
  return () => {
    if (budget.used >= budget.limit) throw new GlobBudgetSpent();
    budget.used++;
  };
}
const rowIdOf = (rule: string | null): string | null => rule === null ? null : SENSITIVE_PATHS.find(row => row.re.source === rule)?.id ?? null;
const globSegment = isGlobWord;

/** X3 r5 sections 1, 3 and 4: list one glob word at one place, names only,
 * and judge what was found. Results are call-local snapshots; work finishing
 * after the deadline can neither publish evidence nor change cwd.
 * - Witness (section 1): an expanded FILE, link or unknown-type entry whose
 *   path (or a link's real path) a PATH_RULES row holds, exactly as the same
 *   path typed literally would be held. An expanded DIRECTORY is a witness
 *   only for a reader (`reader`, default true), by `homeForm(D) + "/"`.
 * - ABSENT (section 4): ENOENT/ENOTDIR drops that branch only.
 * - CANNOT: any other code, the deadline, or a cap. The unlisted frontier
 *   cards iff one of its pairs meets a row folder or the threshold-1 rule.
 * - `..` is walked physically; the POSIX dot rule applies when `dotMatch` is false. */
export async function expandCredentialGlob(token: string, options: {
  cwd?: string; home?: string; deadline?: number; fs?: CredentialGlobFs;
  /** Shared per-command step budget; a fresh one when absent. */
  budget?: GlobStepBudget;
  /** False only for a bare name-only enumerator; absent means reader (fail closed). */
  reader?: boolean;
  /** Leading-dot matching; absent means the POSIX dot rule is OFF (dots match, fail closed). */
  dotMatch?: boolean;
} = {}): Promise<CredentialGlobResult> {
  const deadline = options.deadline ?? performance.now() + 50;
  const fs = options.fs ?? credentialGlobFs;
  const budget = options.budget ?? newGlobStepBudget();
  const reader = options.reader ?? true;
  const dotMatch = options.dotMatch ?? true;
  const platform = process.platform;
  const startUsed = budget.used;
  const charge = chargeGlobStep(budget);
  token = win32Canonical(token, platform);
  if (platform === "win32") token = token.replace(/\\/g, "/");
  const absolute = /^(?:\/|[a-z]:[\\/])/i.test(token);
  type Pair = { directory: string; position: number };
  let witness: string | null = null, witnessRule: string | null = null, budgetSpent = false, lossyUnlisted = false;
  const witnessPaths = new Set<string>();
  // The frontier check (section 4) for one unlisted pair, charged to the budget.
  // A pair with no `base` is a whole word that was never listed.
  type Unlisted = { base?: string; rest: string };
  const frontierRule = (pairs: readonly Unlisted[]): string | null => {
    for (const { base, rest } of pairs) {
      charge();
      if (base === undefined) {
        const hit = unavailableAnchoredGlobRead(rest, platform, options.home, charge);
        if (hit) return hit;
        continue;
      }
      const folder = homeForm(base, platform, options.home).replace(/\/$/, "");
      const hit = matchFirst(PATH_RULES, folder + "/") ?? unavailableAnchoredGlobRead(literalGlobPattern(folder) + "/" + rest, platform, options.home, charge);
      if (hit) return hit;
    }
    return null;
  };
  const finish = (code: string | null, frontier: readonly Unlisted[], absent: boolean): CredentialGlobResult => {
    let kind: CredentialGlobOutcome["kind"], rule: string | null = null;
    if (witness) { kind = "witness"; rule = witnessRule; }
    else if (budgetSpent) { kind = "budget"; rule = GLOB_BUDGET_WORDS; }
    else if (code !== null || frontier.length) {
      kind = "cannot";
      // A folder or link whose name did not decode cleanly was matched but never opened, so what
      // the shell reads through it is unknown: it always cards, with the could-not-check words.
      try { rule = frontierRule(frontier) ?? (lossyUnlisted ? GLOB_BUDGET_WORDS : null); } catch (error) {
        if (!(error instanceof GlobBudgetSpent)) throw error;
        kind = "budget"; rule = GLOB_BUDGET_WORDS;
      }
    } else kind = absent ? "absent" : "listed";
    const cards = rule !== null;
    return {
      available: code === null, witness, rule, textFallback: false, ...(code !== null ? { reason: code } : {}),
      outcome: { kind, cards, rule, witness, rowId: kind === "witness" ? rowIdOf(rule) : null, code, steps: budget.used - startUsed, witnessPaths: [...witnessPaths] },
    };
  };
  if (budget.used >= budget.limit) { budgetSpent = true; return finish(null, [], false); }
  // Without a folder to list from, the whole word is the frontier (a relative one may sit anywhere).
  const whole = (code: string) => finish(code, [{ rest: absolute || token.startsWith("~/") ? token : "/**/" + token }], false);
  let path = token;
  if (/^[a-z]:[\\/]/i.test(path) && platform !== "win32") return whole("platform");
  if (path.startsWith("~/")) {
    if (!options.home) return whole("home");
    path = literalGlobPattern(options.home.replace(/\/$/, "")) + path.slice(1);
  } else if (!absolute) {
    if (!options.cwd) return whole("cwd");
    path = literalGlobPattern(options.cwd.replace(/\/$/, "")) + "/" + path;
  }
  if (globPatternText(path).length > 4096) return whole("syntax");
  if (platform === "win32") path = path.replace(/\\/g, "/");
  const root = path.match(/^[a-z]:\//i)?.[0] ?? (platform === "win32" ? path.match(/^\/\/[^/]+\/[^/]+\//)?.[0] : undefined) ?? "/";
  const segments = path.slice(root.length).split("/").filter(segment => segment !== "" && segment !== ".");
  const join = (directory: string, name: string) => directory.replace(/\/$/, "") + "/" + name;
  // Walk state. Every field is read synchronously when the walk is closed.
  const queue: Pair[] = [{ directory: root, position: 0 }];
  const refused: Pair[] = [], unreadable: { pair: Pair; code: string }[] = [];
  const visited = new Set<string>();
  let current: Pair | null = null, stopped: string | undefined, absent = false, closed = false, entries = 0;
  const live = () => {
    if (closed) throw new GlobDeadline();
    if (performance.now() >= deadline) throw new GlobDeadline();
  };
  const enqueue = (pair: Pair) => {
    if (queue.length >= 256) { refused.push(pair); stopped ??= "queue"; return; }
    queue.push(pair);
  };
  const observe = async (forms: readonly string[], type: "file" | "dir" | "link" | "unknown") => {
    const all = [...forms];
    if (type === "link") {
      try { const real = await fs.realpath(forms[0]!); live(); all.push(real); } catch (error) {
        if (error instanceof GlobDeadline) throw error;
        // An unresolved link is CANNOT evidence for the folder being walked, never a quiet "listed".
        if (current) unreadable.push({ pair: current, code: ioCode(error) });
      }
    }
    for (const form of all) {
      charge();
      const placed = homeForm(form, platform, options.home).replace(/\/$/, "");
      let hit = type !== "dir" ? matchFirst(PATH_RULES, placed) ?? dataCredentialHit([form]) : null;
      if (!hit && reader && type !== "file") hit = matchFirst(PATH_RULES, placed + "/");
      if (hit) { live(); witness ??= forms[0]!; witnessRule ??= hit; witnessPaths.add(form); }
    }
  };
  const walk = async () => {
    while (queue.length && !stopped) {
      live();
      const next = queue.shift()!;
      current = next;
      let physical: string;
      try { physical = await fs.realpath(next.directory); live(); } catch (error) {
        if (error instanceof GlobDeadline) throw error;
        const code = ioCode(error);
        if (ABSENT_CODES.has(code)) absent = true; else unreadable.push({ pair: next, code });
        current = null;
        continue;
      }
      const key = JSON.stringify([physical, next.position]);
      if (visited.has(key)) { current = null; continue; }
      if (visited.size >= 256) { refused.push(next); current = null; stopped = "visited"; break; }
      visited.add(key);
      const segment = segments[next.position];
      if (segment === undefined) { await observe(next.directory === physical ? [physical] : [next.directory, physical], "unknown"); current = null; continue; }
      if (!globSegment(segment)) { enqueue({ directory: join(physical, globPatternText(segment)), position: next.position + 1 }); current = null; continue; }
      const last = next.position === segments.length - 1;
      if (segment === "**" && !last) enqueue({ directory: physical, position: next.position + 1 });
      let dir: Awaited<ReturnType<CredentialGlobFs["opendir"]>>;
      try { dir = await fs.opendir(physical); } catch (error) {
        if (error instanceof GlobDeadline) throw error;
        const code = ioCode(error);
        if (ABSENT_CODES.has(code)) absent = true; else unreadable.push({ pair: next, code });
        current = null;
        continue;
      }
      try {
        live();
        for (;;) {
          let entry: Awaited<ReturnType<typeof dir.read>>;
          try { entry = await dir.read(); } catch (error) { unreadable.push({ pair: next, code: ioCode(error) }); break; }
          live();
          if (!entry) break;
          if (++entries > 2000) { stopped = "entries"; return; }
          // POSIX dot rule: `*`, `?`, `[..]` and `**` never match a leading dot
          if (!dotMatch && entry.name.startsWith(".") && !segment.startsWith(".")) continue;
          if (segment !== "**" && !pathGlobsIntersect([literalGlobPattern(entry.name)], [segment], charge)) continue;
          const child = join(physical, entry.name);
          const type = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file";
          // A name holding U+FFFD may be a lossy decode of raw bytes. That text is not the entry's
          // address: reopening it finds nothing, or a different entry really spelled U+FFFD. The
          // walk never reopens it. The entry is judged by its text and recorded as not listed.
          const lossy = type !== "file" && entry.name.includes("\uFFFD");
          if (last) await observe([child], lossy ? "unknown" : type);
          if (lossy) {
            lossyUnlisted = true;
            unreadable.push({ pair: { directory: child, position: segment === "**" ? next.position : next.position + 1 }, code: "EILSEQ" });
          } else if (type !== "file") {
            if (segment === "**") enqueue({ directory: child, position: next.position });
            else if (!last) enqueue({ directory: child, position: next.position + 1 });
          }
          if (stopped) return;
        }
      } finally {
        // This cleanup occupies the admission slot but never extends the
        // caller's wait. No evidence is written after it.
        await dir.close();
      }
      current = null;
    }
  };
  const result = await admittedPathIO(() => walk().then(() => null as string | null, error => {
    if (error instanceof GlobBudgetSpent) { budgetSpent = true; return null; }
    if (error instanceof GlobDeadline) return "timeout";
    return "unreadable";
  }), deadline);
  // Close the walk and snapshot the unlisted part at once (immutable from here).
  closed = true;
  const stop = "reason" in result ? result.reason : result.value ?? stopped ?? null;
  const pairs: Pair[] = stop !== null ? [...queue, ...(current ? [current] : []), ...refused] : [];
  pairs.push(...unreadable.map(one => one.pair));
  const code = stop ?? unreadable[0]?.code ?? null;
  return finish(code, pairs.map(pair => ({ base: pair.directory, rest: segments.slice(pair.position).join("/") })), absent);
}
const credentialGlobFs: CredentialGlobFs = { realpath: asyncRealpath, opendir: path => asyncOpendir(path, { bufferSize: 1 }) };

/** X3 r5 section 5 with rev 3.2 sections 2-3: the record's constant bounds. */
export { SHELL_MAX_PLACES, SHELL_OVERFLOW_REASON, SHELL_MAX_PENDING, SHELL_MAX_PENDING_BYTES, unionShellState } from "../shared/sensitive-globs.ts";
/** Reason class K (rev 3.2 section 3): one card per overflow episode per record. */
export const K_CARD_RULE = "this session has used more than 32 folders, so Murage now checks every file pattern in it";
/** Reason class P5 (r5:103): every relative glob word in an unknown folder. */
export const P5_CARD_PREFIX = "the folder this command runs in is not known";

const admitPlace = admitShellPlace;
/** P2: an ABSENT target is a pending lexical place, not a place and not unknown. */
const admitPending = admitShellPending;
type FolderOutcome = { path: string } | { code: string };
const absentCode = (code: string): boolean => code === "ENOENT" || code === "ENOTDIR";
async function realFolder(fs: CredentialGlobFs, path: string, deadline: number): Promise<FolderOutcome> {
  const result = await admittedPathIO(() => fs.realpath(path).then(
    (value): FolderOutcome => ({ path: value }),
    (error: { code?: unknown } | undefined): FolderOutcome => ({ code: typeof error?.code === "string" ? error.code : "EUNKNOWN" })), deadline);
  return "reason" in result ? { code: result.reason === "timeout" ? "ETIMEDOUT" : "EBUSY" } : result.value;
}
async function searchable(fs: CredentialGlobFs, path: string, deadline: number): Promise<boolean> {
  const result = await admittedPathIO(async () => { const dir = await fs.opendir(path); await dir.close(); return true; }, deadline);
  return "value" in result;
}

/** Physical H3 effects use at most the first 25 ms of the shared budget.
 * This function returns new state; no asynchronous operation owns live state.
 * `replacement` is P1 (r5:79-86): the final folder set an exit-0 completion of
 * this exact call would prove, or absent when no such proof is possible. */
export async function resolveShellDirectories(text: string, initial: ShellCwdState, options: {
  home?: string; cdpath?: string; shell?: "pwsh"; deadline?: number; fs?: CredentialGlobFs; directoryBuiltins?: boolean;
} = {}): Promise<{ parent: ShellCwdState; local: ShellCwdState; destinations: Set<string>; replacement?: ShellCwdState }> {
  const deadline = options.deadline ?? performance.now() + 25;
  const fs = options.fs ?? credentialGlobFs;
  const parent = copyShellCwdState(initial);
  // S3': each pending ABSENT entry is re-resolved once, at the next call.
  // Existing, it is an ordinary place (and can overflow). Still absent, it is
  // dropped: the cd failed and the shell is not there. Unreadable, it is kept
  // as a place whose listing is CANNOT (fail closed).
  const pending = parent.pending ?? [];
  delete parent.pending;
  for (const path of pending) {
    if (performance.now() >= deadline) { admitPending(parent, path, `shell folder ${path.slice(0, 256)} cannot be proven`); continue; }
    const outcome = await realFolder(fs, path, deadline);
    if ("path" in outcome) admitPlace(parent, outcome.path, `earlier cd ${path.slice(0, 256)}`);
    else if (outcome.code === "ETIMEDOUT" || outcome.code === "EBUSY") admitPending(parent, path, `shell folder ${path.slice(0, 256)} cannot be proven`);
    else if (!absentCode(outcome.code)) admitPlace(parent, path, `earlier cd ${path.slice(0, 256)} (unreadable)`);
  }
  if (setsDotglob(text)) parent.dotglob = true;
  const local = copyShellCwdState(parent);
  const effects = shellDirectoryEffects(text, false, 0, undefined, options.shell);
  const destinations = new Set<string>();
  // P1 chain: the place set after each top-level cd of a single `&&` list.
  const startUnknown = Boolean(parent.unknown);
  const provenCds = options.shell === "pwsh" || options.directoryBuiltins === false || !shellAndList(text) ? -1 : provenCdList(text);
  // Ruling H1 (positive knowledge only): only a text the scanner's tokenizer proves is a flat list of simple commands
  // joined only by `&&`, whose cds are each a plain one-operand `cd`, can be a P1 chain. PowerShell text never is one.
  let chain: { targets: string[]; lastAbsolute: boolean; seen: boolean; command: string } | undefined = options.shell !== "pwsh" && provenCds >= 0
    ? { targets: [...parent.targets.keys()], lastAbsolute: false, seen: false, command: "" } : undefined;
  let parentsRemaining = effects.filter(effect => effect.scope === "parent").length;
  // Ruling H1: every parent directory effect the scanner saw must be one of the proven cd commands (a `cd` inside a
  // comment, `eval`, `source`, `pushd` ... are scanner effects the tokenizer did not prove).
  if (chain && parentsRemaining !== provenCds) chain = undefined;
  for (const effect of effects) {
    if (performance.now() >= deadline) {
      if (parentsRemaining) { parent.unknown ??= "shell folder lookup timed out"; chain = undefined; }
      local.unknown ??= "shell folder lookup timed out";
      break;
    }
    if (effect.scope === "parent") parentsRemaining--;
    if (effect.scope === "child") {
      for (const [path, reason] of parent.targets) {
        if (local.targets.size >= SHELL_MAX_PLACES && !local.targets.has(path)) local.unknown ??= "too many possible shell folders";
        else local.targets.set(path, reason);
      }
      local.unknown ??= parent.unknown;
    }
    const isParent = effect.scope === "parent";
    const targetState = isParent ? parent : local;
    const reason = `shell folder ${effect.command.slice(0, 256)} cannot be proven`;
    const operand = effect.operand && (process.platform === "win32" ? win32Canonical(effect.operand, process.platform).replace(/\\/g, "/") : effect.operand);
    const absoluteOperand = Boolean(operand && (operand.startsWith("/") || (process.platform === "win32" && /^[a-z]:\//i.test(operand))));
    // P4: unknown only for a non-literal operand
    if (options.directoryBuiltins === false) { targetState.unknown ??= reason; if (isParent) chain = undefined; }
    if (effect.kind !== "filesystem" || !operand || effect.flags.includes("-P") || /[$`*?[]|%[^%]+%/.test(operand) || unresolvedShellParent(operand) || (options.cdpath && !absoluteOperand)) {
      targetState.unknown ??= reason;
      if (isParent) chain = undefined;
      continue;
    }
    // P3: `~/` resolves only with the handed HOME
    const absolute = absoluteOperand ? operand : operand.startsWith("~/") && options.home ? options.home + operand.slice(1) : undefined;
    const join = (base: string) => base.replace(/\/$/, "") + "/" + operand;
    const candidates = absolute ? [absolute] : [...targetState.targets.keys()].map(join);
    const chainCandidates = isParent && chain ? absolute ? [absolute] : chain.targets.map(join) : [];
    if (!candidates.length || (operand.startsWith("~") && !absolute)) {
      targetState.unknown ??= reason;
      if (isParent) chain = undefined;
      continue;
    }
    const outcomes = new Map<string, FolderOutcome>();
    for (const path of new Set([...candidates, ...chainCandidates])) {
      if (performance.now() >= deadline) { targetState.unknown ??= reason; if (isParent) chain = undefined; break; }
      outcomes.set(path, await realFolder(fs, path, deadline));
    }
    const placed = `earlier ${effect.command.slice(0, 64)} ${operand.slice(0, 256)}`;
    for (const path of candidates) {
      const outcome = outcomes.get(path);
      if (!outcome) continue;
      if ("path" in outcome) { destinations.add(outcome.path); admitPlace(targetState, outcome.path, placed); }
      else if (absentCode(outcome.code)) admitPending(targetState, path, reason);
      // No answer in time: where the shell went is not known.
      else if (outcome.code === "ETIMEDOUT" || outcome.code === "EBUSY") targetState.unknown ??= reason;
      // P2: a CANNOT target is added; its listing is CANNOT
      else admitPlace(targetState, path, `${placed} (unreadable)`);
    }
    if (isParent && chain) {
      const next: string[] = [];
      for (const path of chainCandidates) {
        const outcome = outcomes.get(path);
        if (outcome && "path" in outcome) { if (!next.includes(outcome.path)) next.push(outcome.path); }
        else if (!outcome || !absentCode(outcome.code)) { chain = undefined; break; }
      }
      if (chain) {
        if (!next.length) chain = undefined;
        else { chain.targets = next; chain.lastAbsolute = Boolean(absolute); chain.seen = true; chain.command = `${effect.command.slice(0, 64)} ${operand.slice(0, 256)}`; }
      }
    }
  }
  for (const [path, reason] of parent.targets) {
    if (local.targets.size >= SHELL_MAX_PLACES && !local.targets.has(path)) local.unknown ??= "too many possible shell folders";
    else local.targets.set(path, reason);
  }
  local.unknown ??= parent.unknown;
  if (parent.capped) local.capped = true;
  // P1 with rev 3.2 section 2 and S-a/S-b: a commit only adds places (a
  // union). Under unknown only an absolute or handed-HOME last cd installs an
  // exact cwd and clears unknown; a relative one keeps unknown, and its
  // candidates are already in the additive state.
  let replacement: ShellCwdState | undefined;
  if (chain?.seen && (!startUnknown || chain.lastAbsolute)) {
    let ok = true;
    for (const path of chain.targets) if (!(await searchable(fs, path, deadline))) { ok = false; break; }
    if (ok) replacement = { targets: new Map(chain.targets.map(path => [path, `committed ${chain!.command}`])), ...(parent.dotglob ? { dotglob: true } : {}), ...(chain.lastAbsolute ? { install: true } : {}) };
  }
  return { parent, local, destinations, ...(replacement ? { replacement } : {}) };
}

/** What one shell call carries that could say where it starts. Proof
 * selection (X3 r5 rev 3.2 section 1) adds its own fields here. */
export interface ShellCall extends ShellProofFacts { namedCwd?: string | null; attributed?: boolean }
/** The start set one call is judged against. `source` "record" is the floor:
 * the session record with every earlier call's effects. Any other source is
 * a per-call start; it never reads the floor, but the call still publishes
 * its effects into the record. */
export interface ShellStartSet {
  state: ShellCwdState;
  source: "record" | "named" | ShellProofSource;
  /** Whether this call's globs match a leading dot. Missing means ON: the
   * owner's ruling for floor and Codex calls. A proof arm sets it from its
   * proof (P-CLAUDE shellProof GLOBIGNORE, P-FUIGO its field, missing = on). */
  dotglob?: boolean;
  /** Why a call that named its driver stayed on the floor (A2 causes, value-free). */
  floor?: ShellFloorCause;
}
/** X3 r5 rev 3.2 section 1: the ONE place a call's start set is chosen.
 * Default: the record (floor). The "named" arm is the pre-existing attributed
 * call folder, kept unchanged until proof selection replaces it. */
export function startSetFor(call: ShellCall, record: ShellCwdState): ShellStartSet {
  // Rev 3.2 section 1: a call that names its driver gets exactly one of the three per-call proofs, else the record.
  // A proven call reads no record (no K, no cross-call P5). Without a bound record (SS:81 `snapshot(undefined)`)
  // `record` is unknown and the proof still applies; nothing re-seeds it from the spawn folder (rev 3.2 section 7).
  if (call.driver !== undefined) {
    const proof = shellProof(call);
    if ("floor" in proof) return { source: "record", state: record, floor: proof.floor, dotglob: true };
    return { source: proof.source, state: { targets: new Map([[proof.cwd, `${proof.source} proven call folder`]]) }, dotglob: proof.dotglob };
  }
  if (call.attributed && call.namedCwd !== undefined) {
    return { source: "named", state: call.namedCwd === null ? { targets: new Map<string, string>(), unknown: "invalid call folder" } : { targets: new Map([[call.namedCwd, "named call folder"]]) } };
  }
  return { source: "record", state: record };
}

/** Ruling H3: the card for a candidate place the 50 ms deadline reached before it was judged. */
export const SHELL_DEADLINE_CARD_RULE = "the file-pattern check ran out of time before every possible folder was looked at";

/** Ruling H4: a prepared floor judgement whose record was retired or whose publish was refused cannot keep its quiet
 * rule. It is judged again against `unknown`: a relative glob word then cards (P5) and the local state is unknown.
 * Anchored globs keep their own verdict, and a call on its own proven start (not the floor) is left alone. */
export function invalidateShellJudgement(prepared: { local: ShellCwdState; rule: string | null; start: ShellStartSet }, text: string, shell?: "pwsh"): void {
  if (prepared.start.source !== "record") return;
  const unknownState: ShellCwdState = { targets: new Map(), unknown: "shell session record retired or its publish was refused" };
  prepared.local = unknownState;
  const payloads: string[] = [];
  shellDirectoryEffects(text, false, 0, payloads, shell);
  const globs = shellGlobWords(text, { ...(shell ? { shell } : {}), payloads, dotglob: true });
  if (globs.incomplete) { prepared.rule ??= GLOB_BUDGET_WORDS; return; }
  if (globs.length > 128) { prepared.rule ??= "too many file patterns to check"; return; }
  if (globs.some(word => !/^(?:\/|[a-z]:[\\/]|~[\\/])/i.test(word.token))) prepared.rule ??= `${P5_CARD_PREFIX} (${unknownState.unknown})`;
}

export async function prepareShellJudgement(text: string, initial: ShellCwdState, options: {
  home?: string; cdpath?: string; shell?: "pwsh"; fs?: CredentialGlobFs;
} & ShellCall = {}): Promise<{ parent: ShellCwdState; local: ShellCwdState; rule: string | null; expansions: CredentialGlobResult[]; replacement?: ShellCwdState; start: ShellStartSet }> {
  const start = performance.now(), deadline = start + 50;
  const startSet = startSetFor(options, initial);
  if (options.driver !== undefined) countShellStart(options.driver, startSet.floor ?? startSet.source);
  const callInitial = startSet.state;
  const directoryBuiltins = options.driver === undefined || startSet.source === "claude";
  const effects = await resolveShellDirectories(text, callInitial, { ...options, directoryBuiltins, deadline: start + 25 });
  // Shadow floor state (A:68), additive only (X3-SIMPLIFY-SaSb S-a, S-b): every call publishes its effects into its
  // record by union; nothing erases an earlier place or clears `unknown` here. A Claude proof's effects are resolved
  // over the record itself and then unioned. Every other per-call start (Fuigo's bound field, Codex `params.cwd`, the
  // named folder) unions its cwd and this call's effects from it. A proven call's P1 commit is kept, and the registry
  // unions it too.
  if (startSet.source === "claude") {
    effects.parent = unionShellState(initial, (await resolveShellDirectories(text, initial, { ...options, directoryBuiltins, deadline: start + 25 })).parent);
  } else if (startSet.source !== "record") {
    effects.parent = unionShellState(initial, effects.parent);
  }
  const expansions: CredentialGlobResult[] = [];
  // Wrapped payloads (env -C, nohup, sudo ... sh -c) that the lexer does not unwrap itself
  const payloads: string[] = [];
  shellDirectoryEffects(text, false, 0, payloads, options.shell);
  let rule: string | null = null;
  // Only destinations visited by this call are folder reads. Retained launch
  // and failure-path candidates remain available for placing actual globs.
  for (const target of effects.destinations) rule ??= matchFirst(PATH_RULES, homeForm(target, process.platform, options.home).replace(/\/$/, "") + "/");
  // P6: a link, copy or mount operand gets the same folder check as a cd operand
  for (const operand of linkCopyOperands(text)) rule ??= matchFirst(PATH_RULES, homeForm(operand, process.platform, options.home).replace(/[\\/]$/, "") + "/");
  // r5 section 2 (G1): glob words come only from the shell lexer, payloads included
  // Owner dot-match ruling: floor and Codex calls match leading dots; a proof
  // arm (P-CLAUDE shellProof, P-FUIGO field) sets startSet.dotglob itself.
  const globs = shellGlobWords(text, { ...(options.shell ? { shell: options.shell } : {}), payloads, dotglob: startSet.dotglob ?? Boolean(effects.local.dotglob) });
  if (globs.incomplete) return { ...effects, rule: GLOB_BUDGET_WORDS, expansions, start: startSet };
  if (globs.length > 128) return { ...effects, rule: "too many file patterns to check", expansions, start: startSet };
  let kShown = false;
  // r5 section 3: one matching-step budget per command, shared by every word and place
  const budget = newGlobStepBudget();
  for (const word of globs) {
    const token = word.token;
    const anchored = /^(?:\/|[a-z]:[\\/]|~[\\/])/i.test(token);
    // rev 3.2 section 3: under unknown a relative glob word is decided before
    // any expansion (no listing). A capped record's first one is the
    // episode's K card; every later one is P5.
    if (!anchored && effects.local.unknown) {
      if (effects.parent.capped && !effects.parent.kShown && !kShown) { kShown = true; rule ??= K_CARD_RULE; }
      else rule ??= `${P5_CARD_PREFIX} (${effects.local.unknown})`;
      continue;
    }
    const bases = anchored ? [undefined] : effects.local.targets.size ? [...effects.local.targets.keys()] : [undefined];
    for (const cwd of bases) {
      // Ruling H3: a place the deadline reached before it was judged is unknown, which is a card; never a silent skip.
      if (performance.now() >= deadline) { rule ??= SHELL_DEADLINE_CARD_RULE; continue; }
      const result = await expandCredentialGlob(token, { home: options.home, cwd, deadline, fs: options.fs, budget, reader: word.reader, dotMatch: word.dotMatch });
      expansions.push(result);
      if (result.outcome.cards) rule ??= result.outcome.rule ?? result.rule;
    }
  }
  if (kShown) effects.parent.kShown = true;
  return { ...effects, rule, expansions, start: startSet };
}

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
  const platform = opts.platform ?? process.platform;
  const paths: string[] = [];
  const add = (spelling: string) => {
    if (spelling === "") return;
    // a Windows spelling is read with its backslashes as `/` too, the way the in-project check reads it
    for (const form of [spelling, spelling.replace(/\\/g, "/")]) if (!paths.includes(form)) paths.push(form);
  };
  let cannot: string | null = given.length > 64 ? "the call names more paths than the key guard follows" : null;
  for (const path of given.slice(0, 64)) {
    // the Win32 spelling of the path as given (`\\?\`, `\\host\C$\`, `::$DATA`, a trailing dot: SG-WIN-PATHTRICKS.md)
    // is read even when it cannot be placed: a hook file named that way is held either way
    const canonical = win32Canonical(path, platform);
    if (canonical !== path) add(canonical);
    const placed = realPathInOrder(path, cwd ?? "", { ...opts, home });
    if ("cannot" in placed) {
      cannot ??= `${path}: ${placed.cannot}`;
      continue;
    }
    if (placed.real !== path) add(placed.real);
    const realCanonical = win32Canonical(placed.real, platform);
    if (realCanonical !== path) add(realCanonical);
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

export const NO_LIMITS_SOURCE: Readonly<Record<AutoVerdictSource, "run" | "keep">> = {
  "always-ask": "run", "narrow": "run", "always-allow": "run", "exact-command": "run", "auto-mode": "run", "full-access": "run",
  "no-limits": "run", "own-workspace": "run", "own-files": "run", "own-tool-results": "run", "project-work-roots": "run",
  "owner-switch":"keep", "own-unasked": "run", "stop-line": "run", "task-allowance": "run", "routine-allow": "run", "unattended-block": "run",
  "local-computer-block": "run", "destructive-guard": "run", "sensitive-guard": "run", "unread-call": "run", "prompt-guard": "run",
  "outside-turn": "run", "question-tool": "keep", "no-grant": "run",
};

export type NoLimitsInitiator = FullAccessOrigin | "unproven";
/** Legacy origin metadata only; registered decision provenance owns permission. */
export function noLimitsInitiator(bot: AutoApprover | null | undefined, context: AutoContext | undefined): NoLimitsInitiator {
  const stored = context?.fullAccessOrigin;
  if (stored === undefined) {
    // routineLevel is the caller's live owner-routine attribution, not a
    // stored permission flag. Legacy callers need no duplicate origin when
    // nothing contradicts that attribution. Unattended work needs its origin.
    return context?.routineLevel === true && context.unattended !== true && context.channelOwner !== true
      && fullAccessCovers(bot, "routine") ? "routine" : "unproven";
  }
  if (stored === "other") return "other";
  if (stored === "owner") {
    if (context!.unattended === true || context!.automated === true || context!.channelOwner === true) return "unproven";
  } else if (stored === "routine") {
    // No limits routines inherit their bot level even when scheduled.
    if (context!.routineLevel !== true || context!.channelOwner === true || context!.unattended === true && !hasNoLimits(bot)) return "unproven";
  } else if (stored === "owner-channel") {
    if (context!.channelOwner !== true) return "unproven";
  } else return "unproven";
  return fullAccessCovers(bot, stored) ? stored : "other";
}

/** Compatibility for pre-integration consumers. Permission authority belongs to
 * decision/index.ts; the BASE policy never re-decides a registered request. */
export function finalizeNoLimits(bot: AutoApprover, tool: string, summary: string, context: AutoContext | undefined, verdict: AutoVerdict, _prior: readonly import("../shared/no-limits-decision.ts").ReaderVerdict[] = []): AutoVerdict {
  if(verdict.source==="owner-switch")return verdict;
  try{
    if (!hasNoLimits(bot)) return verdict;
    const initiator = noLimitsInitiator(bot, context);
    const origin = context?.noLimitsOrigin ?? (context?.fullAccessOrigin === "owner-channel" && context.channelOwner ? "owner-channel" : initiator === 'routine' && context?.unattended !== true ? 'owner-routine' : initiator);
    if (!noLimitsAppliesTo(origin, bot)) return verdict;
  }catch{return verdict;}
  const result = noLimitsOnlyVerdict(tool, summary, context);
  if (verdict.source === "question-tool") return verdict;
  if (result.approve !== null && verdict.approve !== null) return verdict;
  noLimitsFactsOf.set(result, { initiator: noLimitsInitiator(bot, context), n2: result.approve === null });
  if(result.approve!==null)try{logAsked(bot,tool,result,context,verdict);}catch{ /* logging cannot hold a call */ }
  return result;
}
/** Current verdict metadata only; entries disappear with their verdict. */
const noLimitsFactsOf = new WeakMap<AutoVerdict, { initiator: NoLimitsInitiator; n2: boolean }>();
export function noLimitsFacts(verdict: Pick<AutoVerdict, never> | null | undefined): { initiator: NoLimitsInitiator; n2: boolean } | undefined {
  const facts = verdict ? noLimitsFactsOf.get(verdict as AutoVerdict) : undefined;
  return facts ? { ...facts } : undefined;
}
