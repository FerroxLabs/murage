// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// X3 r5 section 2 (which words are globs) and section 1 [S1] (who reads
// the names a glob expands to). Glob words come ONLY from the shell lexer
// (POSIX) or the PowerShell word reader, never from a raw text split. Each
// word carries whether its command is a READER (fail closed: anything but a
// bare name-only enumerator) and whether `*`, `?` and `[..]` may match a
// leading dot.
import { literalGlobPattern, powershellGlobWords } from "../shared/sensitive-globs.ts";
import { lex, lexQuotedBody, renderWord, type Part, type Token, type Word } from "./shell/lex.ts";
import { braceCandidates } from "./shell/walk.ts";
import type { GlobWord } from "./auto-approve.ts";

/** Name-only enumerators (r5 section 1 [R2]). `find` loses the status with an action below. */
const ENUMERATORS = new Set(["ls", "find", "du", "stat", "file", "test", "[", "basename", "dirname", "realpath", "readlink"]);
const FIND_ACTIONS = /^-(?:exec|execdir|ok|okdir|delete|fprint.*|fls)$/;
/** Stripped before the program is named. `env` also loses its `VAR=x` words. */
const WRAPPERS = new Set(["rtk", "command", "builtin", "sudo", "time", "nice", "env", "nohup"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "time"]);
/** Stdin-only filters a bare listing may pass through: no operands, these options only. */
const FILTERS = new Set(["head", "tail", "wc", "sort", "uniq"]);
const FILTER_OPTION = /^-(?:\d+|l|c|w|r|u)$/;
const SHELLS = /^(?:sh|bash|zsh|dash|ksh|fish)$/;
const STDOUT_OPS = new Set([">", ">>", ">|", ">&", "&>", "&>>"]);
const INPUT_OPS = new Set(["<", "<<", "<<-", "<<<", "<&", "<>"]);
/** r5 section 1 dot rule: these turn POSIX dot matching on for the command. */
export const DOTGLOB_ON = /\bshopt\s+(?:-\w+\s+)*-s\s+(?:\w+\s+)*dotglob\b|\bsetopt\s+(?:\w+\s+)*glob_*dots\b|\bGLOBIGNORE=/i;

/** G2: an unquoted `*` or `?`, or a CLOSED bracket expression. A lone `[` or `[[` is not a glob. */
export function isGlobWord(word: string): boolean {
  word = word.replace(/\0[\s\S]/g, "_");
  if (/[*?]/.test(word)) return true;
  for (let i = word.indexOf("["); i >= 0; i = word.indexOf("[", i + 1)) {
    let at = i + 1;
    if (word[at] === "!" || word[at] === "^") at++;
    if (word[at] === "]") at++;
    if (word.indexOf("]", at) >= 0) return true;
  }
  return false;
}

/** Incomplete expansion is never a clean, possibly truncated word list. */
export type GlobWords = GlobWord[] & { incomplete?: true };
class IncompleteGlobCheck extends Error {}

type Stage = { words: Word[]; redirectTargets: Word[]; stdout: boolean; stderr: boolean };

const wordText = (word: Word): string | undefined => {
  let out = "";
  for (const part of word.parts) {
    if (part.kind === "lit") out += part.text;
    else if (part.kind === "tilde") out += "~" + part.user;
    else return undefined;
  }
  return out;
};

/** Whether any alternative can contain a glob, without multiplying alternatives.
 * Four scanner states preserve bracket classes across part/alternative boundaries;
 * quoted characters use the same literal markers as the actual renderer. */
function maySpellGlob(parts: readonly Part[]): boolean {
  const OPEN = 2, NEGATED = 4, BODY = 8, FOUND = 16;
  const textStates = (text: string, initial: number): number => {
    let states = initial;
    if (!states) return 0;
    for (let i = 0; i < text.length; i++) {
      let char = text[i]!;
      if (char === "\0") { i++; char = "_"; }
      else if (char === "*" || char === "?") return FOUND;
      let next = 1; // An opening bracket may start anywhere in the word.
      if (states & BODY) next |= char === "]" ? FOUND : BODY;
      if (states & OPEN) next |= char === "!" || char === "^" ? NEGATED : BODY;
      if (states & NEGATED) next |= BODY;
      if (char === "[") next |= OPEN;
      states = next;
      if (states & FOUND) return FOUND;
    }
    return states;
  };
  const scan = (items: readonly Part[], initial: number): number => {
    let states = initial;
    for (const part of items) {
      switch (part.kind) {
        case "lit": states = textStates(literalGlobPattern(part.text, part.quote !== "none"), states); break;
        case "tilde": states = textStates("~" + part.user, states); break;
        case "glob": states = textStates(part.text, states); break;
        case "var": {
          // A parameter name is a placeholder, never wildcard syntax.
          const value = textStates(literalGlobPattern("$" + part.name, true), states);
          states = value | (part.word && /^:?[-=+?]$/.test(part.op ?? "") ? scan(part.word.parts, states) : 0);
          break;
        }
        case "brace": states = part.alts.reduce((choices, alt) => choices | scan(alt.parts, states), 0); break;
        case "subst": case "procsub": case "arith": break;
      }
      if (states & FOUND) return FOUND;
    }
    return states;
  };
  return Boolean(scan(parts, 1) & FOUND);
}

/** Every spelling bash could hand on for one word, with quoted glob characters preserved as literal bytes. */
function spellings(word: Word, inner: string[]): string[] {
  // A non-pattern word needs no rendering, but its substitutions still run.
  const collect = (parts: readonly Part[]): void => {
    for (const part of parts) {
      if (part.kind === "subst" || part.kind === "procsub") inner.push(part.text);
      else if (part.kind === "var" && part.word && /^:?[-=+?]$/.test(part.op ?? "")) collect(part.word.parts);
      else if (part.kind === "brace") for (const alt of part.alts) collect(alt.parts);
    }
  };
  collect(word.parts);
  if (!maySpellGlob(word.parts)) return [];
  let candidates: Word[];
  try { candidates = braceCandidates(word); } catch { throw new IncompleteGlobCheck(); }
  const out: string[] = [];
  const render = (parts: readonly Part[]): string[] => {
    let choices = [""];
    for (const part of parts) {
      let values: string[];
      switch (part.kind) {
        // an unquoted `*` or `?` lexes as a glob part, so one in a lit was quoted or escaped
        case "lit": values = [literalGlobPattern(part.text, part.quote !== "none")]; break;
        case "tilde": values = ["~" + part.user]; break;
        case "glob": values = [part.text]; break;
        case "var":
          values = ["$" + part.name];
          if (part.word && /^:?[-=+?]$/.test(part.op ?? "")) values.push(...render(part.word.parts));
          break;
        case "subst": case "procsub": values = [""]; break;
        case "arith": values = [""]; break;
        case "brace": values = [""]; break;
      }
      choices = choices.flatMap(prefix => values.map(value => prefix + value));
      if (choices.length > 256) throw new IncompleteGlobCheck();
    }
    return choices;
  };
  for (const candidate of candidates) {
    out.push(...render(candidate.parts));
    if (out.length > 256) throw new IncompleteGlobCheck();
  }
  return out;
}

/** The program a stage runs, past assignments, keywords and wrappers, and the index of its word. */
function programOf(words: readonly Word[]): { name: string; at: number } {
  let at = 0;
  for (; at < words.length; at++) {
    const text = wordText(words[at]!);
    if (text === undefined) return { name: "", at };
    if (/^[A-Za-z_]\w*=/.test(text) || KEYWORDS.has(text)) continue;
    const base = text.replace(/^.*\//, "");
    if (WRAPPERS.has(base)) continue;
    return { name: base, at };
  }
  return { name: "", at };
}

function isFilter(stage: Stage): boolean {
  const { name, at } = programOf(stage.words);
  if (!FILTERS.has(name)) return false;
  for (let k = at + 1; k < stage.words.length; k++) {
    const text = wordText(stage.words[k]!);
    if (text === undefined) return false;
    if (text === "-n" && /^\d+$/.test(wordText(stage.words[k + 1] ?? { parts: [] }) ?? "")) { k++; continue; }
    if (!FILTER_OPTION.test(text)) return false;
  }
  return true;
}

/** X3 r5 section 2: the glob words of one command, with reader and dot status. */
export function shellGlobWords(text: string, options: { shell?: "pwsh"; payloads?: readonly string[]; dotglob?: boolean; handedOn?: boolean; depth?: number } = {}): GlobWords {
  try { return collectShellGlobWords(text, options); }
  catch (error) {
    if (!(error instanceof IncompleteGlobCheck)) throw error;
    return Object.assign([], { incomplete: true as const });
  }
}

function collectShellGlobWords(text: string, options: { shell?: "pwsh"; payloads?: readonly string[]; dotglob?: boolean; handedOn?: boolean; depth?: number } = {}): GlobWord[] {
  const found = new Map<string, GlobWord>();
  const add = (token: string, reader: boolean, dotMatch: boolean) => {
    if (!isGlobWord(token)) return;
    const key = token + "\u0000" + dotMatch;
    const had = found.get(key);
    found.set(key, { token, reader: reader || (had?.reader ?? false), dotMatch });
  };
  const depth = options.depth ?? 0;
  if (depth > 8) throw new IncompleteGlobCheck();
  if (options.shell === "pwsh") {
    // PowerShell [A5]: a path parameter expands wildcards even when quoted; -LiteralPath never does.
    const words = powershellGlobWords(text);
    for (let k = 0; k < words.length; k++) {
      const word = words[k]!;
      if (/^-(?:LiteralPath|LP|PSPath)$/i.test(word)) { k++; continue; }
      if (/^-(?:LiteralPath|LP|PSPath):/i.test(word)) continue;
      add(word, true, true);
    }
    for (const payload of options.payloads ?? []) for (const word of collectShellGlobWords(payload, { ...options, payloads: [], depth: depth + 1 })) add(word.token, word.reader, word.dotMatch);
    return [...found.values()];
  }
  const dotMatch = options.dotglob === true || DOTGLOB_ON.test(text);
  let tokens: Token[];
  try { tokens = lex(text); } catch { throw new IncompleteGlobCheck(); }
  // A group or compound command with any pipe or stdout redirect: its inner
  // stages cannot be placed in the pipeline here, so every word reads (fail closed).
  const grouped = tokens.some(token => token.kind === "op" && /^[(){}]$/.test(token.op))
    || tokens.some(token => token.kind === "word" && /^(?:do|done|then|fi|esac)$/.test(wordText(token.word) ?? ""));
  const handsOn = tokens.some(token => token.kind === "op" && (token.op === "|" || token.op === "|&" || (STDOUT_OPS.has(token.op) && (token.fd === undefined || token.fd === 1))));
  const allRead = options.handedOn === true || (grouped && handsOn);
  const inner: string[] = [];
  const pipelines: Stage[][] = [[]];
  let stage: Stage = { words: [], redirectTargets: [], stdout: false, stderr: false };
  pipelines[0]!.push(stage);
  const newStage = (joined: boolean) => {
    stage = { words: [], redirectTargets: [], stdout: false, stderr: false };
    if (joined) pipelines.at(-1)!.push(stage);
    else pipelines.push([stage]);
  };
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!;
    if (token.kind === "eof") break;
    if (token.kind === "newline") { newStage(false); continue; }
    if (token.kind === "word") { stage.words.push(token.word); continue; }
    if (token.heredoc && !token.heredoc.quoted && /\$\(|`/.test(token.heredoc.body)) {
      for (const part of lexQuotedBody(token.heredoc.body)) if (part.kind === "subst") inner.push(part.text);
    }
    if (STDOUT_OPS.has(token.op) || INPUT_OPS.has(token.op)) {
      const target = tokens[k + 1];
      const targetText = target?.kind === "word" ? wordText(target.word) : undefined;
      if (STDOUT_OPS.has(token.op) && (token.fd === undefined || token.fd === 1)) {
        // Duplication copies the descriptor's CURRENT destination, in shell order.
        if (token.op === ">&" && targetText === "2") stage.stdout = stage.stderr;
        else if (token.op === ">&" && targetText === "-") stage.stdout = false;
        else if (!(token.op === ">&" && targetText === "1")) stage.stdout = true;
      }
      if (token.op === "&>" || token.op === "&>>") stage.stderr = stage.stdout;
      if (STDOUT_OPS.has(token.op) && token.fd === 2) {
        if (token.op === ">&" && targetText === "1") stage.stderr = stage.stdout;
        else if (token.op === ">&" && targetText === "-") stage.stderr = false;
        else if (!(token.op === ">&" && targetText === "2")) stage.stderr = true;
      }
      if (target?.kind === "word" && token.op !== "<<" && token.op !== "<<-") { stage.redirectTargets.push(target.word); k++; }
      continue;
    }
    if (token.op === "|" || token.op === "|&") { newStage(true); continue; }
    newStage(false);
  }
  for (const pipeline of pipelines) {
    for (let s = 0; s < pipeline.length; s++) {
      const current = pipeline[s]!;
      if (!current.words.length && !current.redirectTargets.length) continue;
      const later = pipeline.slice(s + 1);
      const handedOn = allRead || current.stdout || later.some(one => one.stdout || !isFilter(one));
      const { name, at } = programOf(current.words);
      // a value or substitution could spell a find action: only literal and glob words are read
      const args = current.words.slice(at + 1).map(word => word.parts.every(part => part.kind === "lit" || part.kind === "glob" || part.kind === "tilde")
        ? word.parts.map(part => part.kind === "lit" || part.kind === "glob" ? part.text : "~").join("") : undefined);
      const enumerator = ENUMERATORS.has(name) && !(name === "find" && args.some(arg => arg === undefined || FIND_ACTIONS.test(arg)));
      const reader = !enumerator || handedOn;
      for (const word of current.words) for (const spelling of spellings(word, inner)) add(spelling, reader, dotMatch);
      for (const word of current.redirectTargets) for (const spelling of spellings(word, inner)) add(spelling, true, dotMatch);
      // G4 payload dispatchers: a local shell interpreter only
      const rest = current.words.slice(at + 1);
      let payload: { text: string; shell?: "pwsh" } | undefined;
      if (SHELLS.test(name)) {
        const flag = rest.findIndex(word => /^-[a-z]*c[a-z]*$/.test(wordText(word) ?? ""));
        if (flag >= 0 && rest[flag + 1]) payload = { text: renderWord(rest[flag + 1]!) };
      } else if (name === "eval") payload = { text: rest.map(renderWord).join(" ") };
      else if (/^(?:pwsh|powershell)(?:\.exe)?$/i.test(name)) {
        const flag = rest.findIndex(word => /^-(?:c|command)$/i.test(wordText(word) ?? ""));
        if (flag >= 0) payload = { text: rest.slice(flag + 1).map(renderWord).join(" "), shell: "pwsh" };
      } else if (/^cmd(?:\.exe)?$/i.test(name)) {
        const flag = rest.findIndex(word => /^\/[ck]$/i.test(wordText(word) ?? ""));
        if (flag >= 0) payload = { text: rest.slice(flag + 1).map(renderWord).join(" "), shell: "pwsh" };
      }
      if (payload) for (const word of collectShellGlobWords(payload.text, { shell: payload.shell, dotglob: dotMatch, handedOn, depth: depth + 1 })) add(word.token, word.reader, word.dotMatch);
    }
  }
  // `$(..)`, backticks, `<(..)`, `>(..)`: whatever an enumerator prints there is handed on
  for (const body of inner) for (const word of collectShellGlobWords(body, { dotglob: dotMatch, handedOn: true, depth: depth + 1 })) add(word.token, true, word.dotMatch);
  for (const payload of options.payloads ?? []) for (const word of collectShellGlobWords(payload, { dotglob: dotMatch, depth: depth + 1 })) add(word.token, word.reader, word.dotMatch);
  return [...found.values()];
}
