// SPDX-License-Identifier: AGPL-3.0-or-later
import { statSync } from 'node:fs';
import { physicalWipePath } from '../wipe-path.ts';
import type { OwnerOperation } from '../no-limits-inspection.ts';
import { forEachOwnerSegment } from '../no-limits-shell.ts';
import { readExecutableEffectsOwnerNl } from '../no-limits-code.ts';
import { lexCmd } from '../shell/pwsh.ts';
import { literalText } from '../shell/lex.ts';
import {parse,walk} from '../wipe/invocation.ts';
import {cleanText} from '../wipe/expand.ts';
import {known,opaque,type WipeContext,type ShellState} from '../wipe/types.ts';
import {RootClassifier} from '../wipe/roots.ts';
import {registeredWipeProjects} from '../wipe/registry.ts';
import { canonical } from './bounds.ts';

/** No command option grammar participates here. Every token, including the
 * executable and option values, is probed in order. Keep token positions and
 * duplicate objects; neither set equality nor lexical path equality suffices. */
export function wipeFingerprint(operation: OwnerOperation, wipeClass: string, context?:WipeContext): { fingerprint: string; resolvedTargets: readonly string[] } {
  if (operation.cwdInvalid) throw new Error('wipe-fingerprint-invalid-cwd');
  const commands: Array<{ argv: readonly string[]; objects: unknown[] }> = [];
  const targets = new Set<string>();
  const capture = (values: readonly (string | undefined)[], cwd = operation.cwd) => {
    if (values.some(value => value === undefined)) throw new Error('wipe-fingerprint-unknown-argv');
    const argv = values as readonly string[], objects: unknown[] = [];
    for (let index = 0; index < argv.length; index++) {
      const rawToken = argv[index]!;
      // Grammar-free embedded values: bind the whole token and its suffix
      // after '=' for every program/key, never just known destructive options.
      // This retains dd of= and --key= paths without reviving disk grammars.
      const equals = rawToken.indexOf('=');
      const probes = [{ probe: 'whole', token: rawToken }, ...(equals < 0 ? [] : [{ probe: 'equals-suffix', token: rawToken.slice(equals + 1) }])];
      for (const { probe, token } of probes) {
        if (!token) { objects.push({ index, probe, state: 'empty' }); continue; }
        const target = physicalWipePath(token, cwd, true);
        if (target === undefined) { objects.push({ index, probe, state: 'absent' }); continue; }
        const identity = statSync(target, { bigint: true });
        objects.push({ index, probe, state: 'present', target, device: String(identity.dev), inode: String(identity.ino) });
        targets.add(target);
      }
    }
    commands.push({ argv, objects });
  };
  // Resolve semantic argv with the same v3 expansion model and engine values
  // used by the verdict. Keep the original grammar-free token probes as well.
  const engineShell=operation.kind==='exec'&&context?.env!==undefined;
  if(engineShell&&operation.kind==='exec'){
    const home=context?.home??context?.env?.HOME??context?.env?.USERPROFILE??'';
    const env=new Map(Object.entries({HOME:home,USERPROFILE:home,...context?.env}));
    const classifier=new RootClassifier(context!,context?.registry??registeredWipeProjects);
    const state:ShellState={env,home,cwd:operation.cwd?known(operation.cwd):opaque('cwd'),startCwd:operation.cwd,dialect:operation.dialect,platform:context?.platform,depth:0,vars:new Map(),arrays:new Map(),functions:new Map(),links:new Map(),dirStack:[],drive:/^([a-z]:)/i.exec(operation.cwd??'')?.[1],lexicalProtected:path=>classifier.classify(known(path))!==undefined};
    for(const invocation of walk(parse(cleanText(operation.text),operation.dialect),state)){
      const values=[...invocation.argv,...invocation.redirects.map(redirect=>redirect.target)];
      capture([invocation.program,...values.flatMap(value=>value.k==='known'?[value.s,...(value.candidates??[]),...(value.glob?[value.glob.dir]:[])]:[undefined])],invocation.cwd.k==='known'?invocation.cwd.s:undefined);
    }
  }
  const captureShell = (text: string, initialCwd = operation.cwd, dialect: 'posix' | 'pwsh' = 'posix') => {
    forEachOwnerSegment(text, initialCwd, row => {
      if (!row.values.length && !row.segment.redirects.length && !row.segment.assignments.length) return;
      const values = [...row.values.map((value,index)=>value??(engineShell?row.segment.words[index]?.raw:undefined)), ...row.segment.assignments.map(word => word.text), ...row.segment.redirects.flatMap(redirect => redirect.target ? [redirect.target.text] : [])];
      capture(values);
      for (const cwd of row.selected) if (cwd !== operation.cwd) capture(values, cwd);
    }, dialect);
  };
  if (engineShell && operation.kind==='exec' && operation.dialect==='cmd') {
    commands.push({argv:[operation.text],objects:[]});
  } else if (operation.kind === 'exec' && operation.dialect === 'cmd') {
    let argv: Array<string | undefined> = [];
    const flush = () => { if (argv.length) capture(argv); argv = []; };
    for (const token of lexCmd(operation.text)) {
      if (token.kind === 'op') flush();
      else argv.push(token.kind === 'word' ? literalText(token.word) : token.target ? literalText(token.target) : undefined);
    }
    flush();
  } else if (operation.kind === 'exec') {
    captureShell(operation.text, operation.cwd, operation.dialect === 'pwsh' ? 'pwsh' : 'posix');
  } else if (operation.kind === 'native') {
    capture(operation.effects.flatMap(effect => [effect.path, ...(effect.source === undefined ? [] : [effect.source])]));
  } else {
    // Bind semantic executable argv before the language reader normalizes
    // paths. Keep exact issued code and native effect diagnostics as well.
    const read = readExecutableEffectsOwnerNl(operation.lang, operation.text, undefined, 0, operation.cwd, captureShell);
    capture(read.targets.map(target => target.path));
    commands.push({ argv: [operation.text], objects: [] });
  }
  if (!commands.length) throw new Error('wipe-fingerprint-empty-command');
  return { fingerprint: canonical({ version: 3, wipeClass, commands }), resolvedTargets: [...targets].sort() };
}
