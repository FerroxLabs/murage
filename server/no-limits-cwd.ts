// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { homedir } from 'node:os';
import { candidatesOf } from './shell/walk.ts';
import { producerDependencyRootMatches } from './no-limits-producer-hazards.ts';
import { anchoredPath, lexicalPath, pathKey, resolveNoLimitsPath, spellPath, type CwdCandidate, type CwdLocation, type FsContext } from './no-limits-fs.ts';

export const MAX_CWD_CANDIDATES = 16;
export const MAX_CWD_STACK = 32;
const location = (candidate: CwdCandidate): CwdLocation => Object.freeze({ logical: candidate.logical, physical: candidate.physical });
const freezeCandidate = (candidate: CwdCandidate): CwdCandidate => Object.freeze({ ...candidate, oldpwd: candidate.oldpwd && Object.freeze({ ...candidate.oldpwd }), stack: Object.freeze(candidate.stack.map(value => Object.freeze({ ...value }))), ...(candidate.fixedPrefixes ? { fixedPrefixes: Object.freeze([...candidate.fixedPrefixes]) } : {}) });
export function boundedCwds(values: readonly CwdCandidate[]): readonly CwdCandidate[] {
  const unique = [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  if (unique.length <= MAX_CWD_CANDIDATES) return Object.freeze(unique.map(freezeCandidate));
  const prefixes = [...new Set(unique.flatMap(value => [value.logical, value.physical, ...(value.fixedPrefixes ?? [])].filter((path): path is string => path !== undefined)))];
  // Keep concrete candidates as well as Unknown; known protected branches may
  // not disappear merely because an ordinary branch overflowed the budget.
  return Object.freeze([...unique.slice(0, MAX_CWD_CANDIDATES - 1).map(freezeCandidate), freezeCandidate({ stack: [], unknownCause: 'cwd-candidate-overflow', fixedPrefixes: prefixes })]);
}
export function initialCwds(context: FsContext): readonly CwdCandidate[] {
  if (context.cwdInvalid || !context.cwd) return boundedCwds([{ stack: [], unknownCause: context.cwdInvalid ? 'invalid-cwd' : 'unknown-cwd' }]);
  const resolved = resolveNoLimitsPath(context.cwd, context);
  return boundedCwds([{ logical: lexicalPath(context.cwd, context), ...(resolved.kind === 'known' ? { physical: resolved.physical } : { unknownCause: resolved.kind === 'unknown' ? resolved.cause : 'resolution-exhausted' }), stack: [] }]);
}
export interface CdOptions { mode: 'logical' | 'physical'; requirePhysical: boolean; alternate: boolean; operand?: string; invalid?: boolean }
export function parseCdOptions(args: readonly string[]): Readonly<CdOptions> {
  const result: CdOptions = { mode: 'logical', requirePhysical: false, alternate: false };
  let options = true;
  for (const arg of args) {
    if (options && arg === '--') { options = false; continue; }
    if (options && arg !== '-' && arg.startsWith('-')) {
      for (const flag of arg.slice(1)) {
        if (flag === 'P') result.mode = 'physical';
        else if (flag === 'L') result.mode = 'logical';
        else if (flag === 'e') result.requirePhysical = true;
        else if (flag === '@') result.alternate = true;
        else result.invalid = true;
      }
      continue;
    }
    if (result.operand !== undefined) result.invalid = true;
    else result.operand = arg;
  }
  return Object.freeze(result);
}
export interface CwdTransition {
  readonly all: readonly CwdCandidate[];
  readonly success: readonly CwdCandidate[];
  readonly parsed?: Readonly<CdOptions>;
}
export interface DirectoryValue { readonly value?: string; readonly unknownCause?: string }
/** Values are the collector's existing expansions, not reparsed renderWord.
 * Unlike producer operands, statically expanded cwd variables remain known. */
export function transitionCwd(candidates: readonly CwdCandidate[], command: 'cd' | 'pushd' | 'popd', args: readonly string[], context: FsContext, expanded?: readonly DirectoryValue[]): CwdTransition {
  const parsed = parseCdOptions(command === 'cd' ? args : []);
  const next: CwdCandidate[] = [];
  const unknown = (candidate: CwdCandidate, cause: string) => next.push({ oldpwd: location(candidate), stack: candidate.stack, unknownCause: cause });
  for (const candidate of candidates) {
    const operand = command === 'cd' ? parsed.operand : args[0];
    if (command === 'popd' || command === 'pushd' && (operand === undefined || /^[+-]\d+$/.test(operand))) {
      const chain = [location(candidate), ...candidate.stack];
      const numeric = operand === undefined ? (command === 'popd' ? 0 : 1) : Number(operand.slice(1));
      const index = operand?.startsWith('-') ? chain.length - 1 - numeric : numeric;
      if (index < 0 || index >= chain.length || chain.length < 2) { unknown(candidate, 'unknown-directory-stack'); continue; }
      let selected: CwdLocation, stack: CwdLocation[];
      if (command === 'popd') {
        const remaining = chain.filter((_, i) => i !== index);
        selected = remaining[0]!; stack = remaining.slice(1);
      } else {
        const rotated = [...chain.slice(index), ...chain.slice(0, index)];
        selected = rotated[0]!; stack = rotated.slice(1);
      }
      next.push({ ...selected, oldpwd: location(candidate), stack, ...(candidate.stackUnknown ? { stackUnknown: true } : {}) });
      continue;
    }
    if (parsed.invalid || parsed.alternate || command === 'pushd' && args.length > 1) { unknown(candidate, parsed.alternate ? 'alternate-directory-semantics' : 'unknown-cd-options'); continue; }
    if (operand === '-') {
      if (candidate.oldpwd) next.push({ ...candidate.oldpwd, oldpwd: location(candidate), stack: candidate.stack });
      else unknown(candidate, 'unknown-oldpwd');
      continue;
    }
    const values = expanded ?? [{ value: operand ?? context.home ?? homedir() }];
    for (const value of values.length ? values : [{ unknownCause: 'unknown-directory-value' }]) {
      if (value.value === undefined || value.unknownCause) { unknown(candidate, value.unknownCause ?? 'unknown-directory-value'); continue; }
      const path = spellPath(value.value, context);
      const base = parsed.mode === 'physical' ? candidate.physical : candidate.logical;
      if (!anchoredPath(path) && !base) { unknown(candidate, 'unknown-cwd'); continue; }
      // CDPATH can locate a bare relative directory outside the current folder.
      if (!anchoredPath(path) && !path.startsWith('.') && context.runtimePaths?.CDPATH) unknown(candidate, 'cdpath-dependent');
      const logical = parsed.mode === 'logical' ? lexicalPath(value.value, { ...context, cwd: base }) : undefined;
      const result = resolveNoLimitsPath(logical ?? value.value, { ...context, cwd: base, followFinal: true });
      const traversal = [lexicalPath(value.value, { ...context, cwd: base }), ...(result.footprint ?? [])];
      if (context.cwdDependencyRoots?.some(root => traversal.some(value => {
        const anchor = pathKey(lexicalPath(root, context), context.windows).replace(/\/$/, '');
        const at = pathKey(value, context.windows);
        return at === anchor || at.startsWith(anchor + '/');
      })) || context.cwdDependencyPatterns?.some(root => traversal.some(value => producerDependencyRootMatches(value, root, context)))) unknown(candidate, 'producer-dependency-cwd');
      if (result.kind !== 'known') { unknown(candidate, result.kind === 'unknown' ? result.cause : 'resolution-exhausted'); continue; }
      if (!result.exists || !result.directory) continue; // cd cannot succeed on this initial-disk path.
      const stack = command === 'pushd' ? [location(candidate), ...candidate.stack] : candidate.stack;
      next.push({ logical: parsed.mode === 'physical' ? result.physical : logical, physical: result.physical, oldpwd: location(candidate), stack: stack.slice(0, MAX_CWD_STACK), ...((candidate.stackUnknown || stack.length > MAX_CWD_STACK) ? { stackUnknown: true } : {}) });
    }
  }
  const success = boundedCwds(next);
  return Object.freeze({ all: boundedCwds([...candidates, ...success]), success, parsed });
}

export { unknownCwdSuffixDecisions } from './no-limits-fs.ts';

// The collector owns traversal; this adapter only annotates its once-only
// scope transitions and returns the location used for later expansions.
export function ownerCwdHooks(context: FsContext): import('./no-limits-collect.ts').CollectionHooks<readonly CwdCandidate[]> {
  type Scope = import('./no-limits-collect.ts').CollectorScope;
  const states = new Map<string, readonly CwdCandidate[]>();
  const skipped = new Map<string, readonly CwdCandidate[]>();
  const activeCall = new Map<string, readonly CwdCandidate[]>();
  const get = (scope: Scope) => {
    let value = states.get(scope.id);
    if (!value) { value = initialCwds({ ...context, cwd: scope.context.cwd }); states.set(scope.id, value); }
    return value;
  };
  const set = (scope: Scope, values: readonly CwdCandidate[]) => {
    const bounded = boundedCwds(values.length ? values : [{ stack: [], unknownCause: 'unavailable-success-cwd' }]);
    states.set(scope.id, bounded);
    const logical = new Set(bounded.map(value => value.logical ?? value.physical));
    scope.context.cwd = logical.size === 1 ? [...logical][0] : undefined;
    scope.context.cwdConflict = logical.size > 1 || logical.has(undefined);
  };
  return {
    locate: get,
    fork: (parent, child, kind) => {
      set(child, kind === 'function' && child.id.endsWith('/call') ? activeCall.get(parent.id) ?? get(parent) : get(parent));
      skipped.set(child.id, skipped.get(parent.id) ?? []);
    },
    merge: (target, branches) => set(target, [...get(target), ...branches.flatMap(branch => [...get(branch)])]),
    advance: (record, scope) => {
      const name = record.command.name.toLowerCase().replace(/\.exe$/, '');
      const before = get(scope);
      activeCall.set(scope.id, before);
      if (!['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location', 'popd', 'pop-location'].includes(name)) {
        if (record.next !== 'success') { set(scope, [...before, ...(skipped.get(scope.id) ?? [])]); skipped.delete(scope.id); }
        return;
      }
      const kind = name === 'pushd' || name === 'push-location' ? 'pushd' : name === 'popd' || name === 'pop-location' ? 'popd' : 'cd';
      const words = record.command.args;
      const rawArgs = words.map(word => {
        // Only argument/option shape uses literal text. The directory value
        // itself comes from raw expansion candidates, never renderWord.
        if (word.parts.every(part => part.kind === 'lit')) return word.parts.map(part => part.kind === 'lit' ? part.text : '').join('');
        return '\u0001';
      });
      const indexedArgs = rawArgs.map((value, index) => ({ value, index })).filter(({ value }) => {
        if (record.dialect === 'cmd' && kind === 'cd' && value.toLowerCase() === '/d') return false;
        if (record.dialect === 'pwsh' && /^-(?:literalpath|path|passthru)$/i.test(value)) return false;
        return true;
      });
      const args = indexedArgs.map(arg => arg.value);
      let operandIndex: number | undefined;
      let options = true;
      for (let i = 0; i < args.length; i++) {
        if (options && args[i] === '--') { options = false; continue; }
        if (options && args[i] !== '-' && args[i]!.startsWith('-')) continue;
        operandIndex = i; break;
      }
      let expanded: DirectoryValue[] | undefined;
      if (operandIndex !== undefined) {
        try {
          const candidates = candidatesOf(words[indexedArgs[operandIndex]!.index]!, scope.context);
          expanded = candidates.map(value => value.kind === 'literal' ? { value: value.path } : { unknownCause: 'unknown-directory-value' });
        } catch { expanded = [{ unknownCause: 'unknown-directory-value' }]; }
      }
      const transition = transitionCwd(get(scope), kind, args, context, expanded);
      if (record.next === 'success') {
        skipped.set(scope.id, boundedCwds([...(skipped.get(scope.id) ?? []), ...before]));
        set(scope, transition.success);
      } else {
        set(scope, [...transition.all, ...(skipped.get(scope.id) ?? [])]);
        skipped.delete(scope.id);
      }
    },
  };
}
