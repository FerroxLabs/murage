// SPDX-License-Identifier: AGPL-3.0-or-later
// OVERREACH #6 (MAIN 2026-11-27): a command that runs a script this session wrote has the script's body read for the wipe check, and for nothing else.
import { posix } from 'node:path';
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import type { Node, Script, Word, WipeContext } from './types.ts';
import { parse } from './invocation.ts';
import { cleanText } from './expand.ts';

export const SCRIPT_DEPTH_MAX = 2;
const CWD_MAX = 32;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'source', '.']);
const PYTHONS = /^python[\d.]*$/;
const NODES = new Set(['node', 'nodejs']);
export type ScriptRun = { path: string; lang: 'sh' | 'py' | 'js'; cwd?: string; /** the candidate folders overflowed before this run: the file it names cannot be located, so the caller cards */ overflow?: true };

const langOf = (path: string): ScriptRun['lang'] => /\.py$/i.test(path) ? 'py' : /\.(?:m?js|cjs)$/i.test(path) ? 'js' : 'sh';

/** Bounded, regular-file-only read of a script body. Bytes are inspected, never executed. */
export function readScriptBody(path: string): { text: string } | 'unavailable' {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return 'unavailable';
    const bytes = Buffer.alloc(131_073);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, used);
      if (count === 0) break;
      used += count;
    }
    return used > 131_072 ? 'unavailable' : { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)) };
  } catch { return 'unavailable'; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const literal = (word: Word): string | undefined => word.parts.every(part => part.k === 'lit') ? word.parts.map(part => part.k === 'lit' ? part.s : '').join('') : undefined;
/** Every simple command's words, literal where the word is plain text, through blocks, groups, functions, pipes and lists. */
function commandWords(script: Script, out: (string | undefined)[][] = []): (string | undefined)[][] {
  const visit = (node: Node): void => {
    if (node.k === 'cmd') out.push(node.c.words.map(literal));
    else if (node.k === 'pipe') node.stages.forEach(visit);
    else if (node.k === 'list') node.items.forEach(visit);
    else if (node.k === 'block' || node.k === 'func' || node.k === 'group' || node.k === 'subshell') commandWords(node.body, out);
  };
  script.nodes.forEach(visit);
  return out;
}

/** The session-written scripts this text runs: a shell or interpreter given the file, `source`/`.`, or the file run by its own path. */
export function writtenScriptRuns(text: string, ctx: WipeContext, home: string): ScriptRun[] {
  const edits = ctx.sessionEdits;
  if (!edits || edits.size === 0) return [];
  const start = ctx.cwdOpaque ? undefined : ctx.cwd ?? ctx.workFolder ?? ctx.project;
  const found = new Map<string, ScriptRun>();
  // every folder the text may be running in: the start, and each folder a literal `cd`/`pushd` before the command moves to
  // a set, bounded: each cd would otherwise double it (distinct names) and the approval path is synchronous
  const cwds = new Set<string>(start ? [start] : []);
  const lastCwd = (): string | undefined => [...cwds].at(-1);
  // full: a folder the shell may still be in could be dropped (a failing cd leaves it where it was), so the run fails closed instead of evicting
  let overflowed = false;
  const addCwd = (dir: string): void => {
    // a folder the text returns to moves to the end: the last folder it moved to is always the newest
    cwds.delete(dir);
    if (cwds.size >= CWD_MAX) { overflowed = true; return; }
    cwds.add(dir);
  };
  const take = (raw: string, lang?: ScriptRun['lang']): void => {
    const spelled = raw.replace(/^~(?=\/|$)/, home);
    // past the overflow the folder the text is in is unknown, and a script's body (relative paths, `rm -rf .`) depends on it: a file this session
    // wrote under that name in ANY folder fails closed; a name no session write could match (the old rule's scope) is not read and not carded
    if (overflowed) {
      // compared case- and Unicode-insensitively: a macOS volume treats `Wipe.SH` and `wipe.sh`, and a composed and a decomposed accent, as one file,
      // and here a wrong guess only adds a card
      const fold = (name: string): string => name.normalize('NFD').toLowerCase().normalize('NFD');
      const tail = fold(`/${posix.normalize(spelled).replace(/^(?:\.\.\/)+/, '')}`);
      const abs = spelled.startsWith('/') ? new Set([fold(posix.normalize(spelled)), fold(raw)]) : undefined;
      const named = [...edits].some(edit => abs ? abs.has(fold(edit)) : fold(edit).endsWith(tail));
      if (named) found.set(`${raw}\0overflow`, { path: raw, lang: lang ?? langOf(raw), overflow: true });
      return;
    }
    // the script runs in the folder the text is in when it reaches the command, which a cd or pushd may have changed: every folder the text
    // may be in is tried and EVERY session-written file it names is read (a harmless same-named file elsewhere never masks the one that runs)
    const options: [string, string | undefined][] = [[raw, lastCwd()], ...(spelled.startsWith('/') ? [[posix.normalize(spelled), lastCwd()] as [string, string | undefined]] : [...cwds].map((dir): [string, string | undefined] => [posix.resolve(dir, spelled), dir]))];
    for (const [path, dir] of options) if (edits.has(path)) found.set(`${path}\0${dir ?? ''}`, { path, lang: lang ?? langOf(path), ...(dir ? { cwd: dir } : {}) });
  };
  let commands: (string | undefined)[][] = [];
  try { commands = commandWords(parse(cleanText(text), 'sh')); } catch { commands = []; }
  for (const words of commands) {
    const name = words[0]?.split('/').at(-1);
    if (name === undefined) continue;
    if (name === 'cd' || name === 'pushd') {
      const target = words.slice(1).find(word => word === undefined || !word.startsWith('-'));
      if (target !== undefined && target !== '-') for (const dir of [...cwds]) addCwd(target.startsWith('/') ? posix.normalize(target) : target.startsWith('~') ? posix.normalize(target.replace(/^~(?=\/|$)/, home)) : posix.resolve(dir, target));
      continue;
    }
    const lang = SHELLS.has(name) ? 'sh' : PYTHONS.test(name) ? 'py' : NODES.has(name) ? 'js' : undefined;
    if (!lang) { if (words[0] !== undefined && /^(?:\.{1,2}|~)?\//.test(words[0])) take(words[0]); continue; }
    const args = words.slice(1);
    const first = args.findIndex(word => word === undefined || word === '-' || !word.startsWith('-'));
    if (first < 0 || args[first] === '-') continue; // a lone `-` reads the code from stdin
    // an option that takes the code itself or runs nothing (`-c`, `-e`, `-p`, `-m`, `-s`, `-n`, `--check`) means no file is run
    if (args.slice(0, first).some(word => word !== undefined && (word === '--check' || (lang === 'sh' ? /^-[a-zA-Z]*[csn]/ : /^-[a-zA-Z]*[cepm]/).test(word)))) continue;
    if (args[first] !== undefined) take(args[first]!, lang);
  }
  return [...found.values()];
}
