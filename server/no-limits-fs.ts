// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner No limits only. No future filesystem state and no legacy link tables.
import { lstatSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { protectedCwdSuffix } from './no-limits-cwd-suffix.ts';
import { protectedClass } from './always-ask.ts';
import { ownerMarks } from './shell/marks.ts';
import { gateHit, ruleRowId } from '../shared/gate-files.ts';
import { noLimitsNamedFiles } from '../shared/no-limits-path-policy.ts';

export type Dialect = 'sh' | 'pwsh' | 'cmd';
export type FileIdentity = Readonly<{ dev: string; ino: string; nlink: number }>;
export type CwdLocation = Readonly<{ logical?: string; physical?: string }>;
export type CwdCandidate = Readonly<CwdLocation & {
  oldpwd?: CwdLocation; stack: readonly CwdLocation[]; stackUnknown?: boolean; unknownCause?: string; fixedPrefixes?: readonly string[];
}>;
export type Resolution =
  | Readonly<{ kind: 'known'; lexical: string; physical: string; identity?: FileIdentity; exists: boolean;
      directory?: boolean; regular?: boolean; footprint: readonly string[]; linkValues: readonly string[] }>
  | Readonly<{ kind: 'unknown'; lexical?: string; fixedPrefix?: string; cause: string; footprint?: readonly string[]; linkValues?: readonly string[] }>
  | Readonly<{ kind: 'exhausted'; lexical: string; hops: number; footprint: readonly string[]; linkValues: readonly string[] }>;
export type NativeEffect = Readonly<{
  operandId?: string; op: 'write' | 'edit' | 'delete' | 'create-name' | 'rename' | 'link' | 'copy';
  path: string; source?: string; followFinal: boolean; recursive?: boolean;
  linkKind?: 'symbolic' | 'junction' | 'hard'; targetValue?: string; sourceFollowFinal?: boolean;
}>;
export type InspectedOperation =
  | Readonly<{ kind: 'exec'; dialect: Dialect; text: string; cwd?: string; cwdInvalid: boolean }>
  | Readonly<{ kind: 'native'; effects: readonly NativeEffect[]; cwd?: string; cwdInvalid: boolean }>;
export type TaintCause = 'protected' | 'unknown-expansion' | 'dotdot-value' | 'producer-dependency' | 'other-unknown';
export type ProtectedDecision = Readonly<{
  operandId: string; op: string; reason: 'direct-path' | 'alias-taint' | 'effective-destination' | 'unknown-cwd-protected-suffix' |
    'hard-link-source' | 'protected-inode' | 'resolution-exhausted';
  ruleId: string; protectedClass: string; lexical: string; physical?: string; sourcePhysical?: string;
  identity?: FileIdentity; namedProtectedPath?: string; taintOperationIds?: readonly string[];
  matchedPrefix?: string; resolution: Resolution; taintCauses?: readonly TaintCause[];
  dependencyOperationIds?: readonly string[];
  destinationPlacement?: Readonly<{ sourceOperandId: string; directory: string; child: string; semantics: string }>;
  observedDestinationResolution?: Resolution; cwdCandidates?: readonly CwdCandidate[];
  matchedProtectedSuffix?: string; possibleProtectedName?: string;
}>;
export type JudgedEffect = Readonly<{ effect: NativeEffect; resolution: Resolution; decisions: readonly ProtectedDecision[] }>;
export type NativeInspection = Readonly<{ verdict: 'run' | 'hold'; decisions: readonly ProtectedDecision[]; effects: readonly JudgedEffect[] }>;

/** bigint stats prevent rounding before dev/ino are converted to strings. */
export interface DiskStat {
  dev: bigint | string; ino: bigint | string; nlink: bigint | number;
  isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean;
}
export interface NoLimitsDisk {
  lstat(path: string): DiskStat;
  stat(path: string): DiskStat;
  readlink(path: string): string;
  readdir(path: string): readonly string[];
}
export const noLimitsDisk: NoLimitsDisk = Object.freeze({
  lstat: (path: string) => lstatSync(path, { bigint: true }),
  stat: (path: string) => statSync(path, { bigint: true }),
  readlink: (path: string) => readlinkSync(path),
  readdir: (path: string) => readdirSync(path),
});
export interface FsContext {
  cwd?: string; cwdInvalid?: boolean; home?: string; runtimePaths?: Readonly<Record<string, string>>; namedProtectedPaths?: readonly string[];
  disk?: NoLimitsDisk; remote?: boolean; windows?: boolean; cwdDependencyRoots?: readonly string[];
  cwdDependencyPatterns?: readonly Readonly<{ path?: string; cwd?: string; backupOf?: string }>[];
}
export interface ResolveOptions extends FsContext { followFinal?: boolean; maxHops?: number }

/** Same owner initial-cwd policy as autoVerdict; an explicitly invalid cwd must
 * survive as invalid instead of falling back to workFolder. */
export function effectiveCwd(context?: { commandCwdInvalid?: boolean; commandCwd?: string; exactCommand?: { cwd?: string }; workFolder?: string }): string | undefined {
  return context?.commandCwdInvalid ? '' : context?.commandCwd || context?.exactCommand?.cwd || context?.workFolder;
}
export const ordinaryStream = (path: string): boolean => /^\/dev\/(?:null|zero|random|urandom|tty|stdin|stdout|stderr|fd\/\d+)$/.test(path);
export const windowsPath = (path: string): boolean => /^[a-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]+/i.test(path);
export const pathKey = (path: string, windows = windowsPath(path)): string => windows ? path.replaceAll('\\', '/').toLowerCase() : path;
export const anchoredPath = (path: string): boolean => path.startsWith('/') || /^[a-z]:\//i.test(path);
export function spellPath(raw: string, context: FsContext = {}): string {
  const literal = raw.startsWith('\u0000');
  const unmarked = literal ? raw.slice(1) : raw;
  let path = context.windows || windowsPath(unmarked) ? unmarked.replaceAll('\\', '/') : unmarked;
  const home = context.home ?? homedir();
  if (!literal && /^~(?:[\\/]|$)/.test(path)) path = home.replaceAll('\\', '/') + path.slice(1).replaceAll('\\', '/');
  return path;
}
function rootAndParts(path: string): { root: string; parts: string[] } {
  const root = /^\/\/[^/]+\/[^/]+\/?/.exec(path)?.[0].replace(/\/?$/, '/') ?? /^[a-z]:\//i.exec(path)?.[0] ?? (path.startsWith('/') ? '/' : '');
  return { root, parts: path.slice(root.length).split('/').filter(part => part !== '' && part !== '.') };
}
export function lexicalPath(raw: string, context: FsContext = {}): string {
  const path = spellPath(raw, context);
  const cwd = spellPath(context.cwd ?? '', context);
  const joined = anchoredPath(path) ? path : cwd ? `${cwd}/${path}` : path;
  const { root, parts } = rootAndParts(joined);
  const names: string[] = [];
  for (const part of parts) {
    if (part === '..' && names.length && names.at(-1) !== '..') names.pop();
    else if (part !== '..' || !root) names.push(part);
  }
  return root + names.join('/');
}
const fsCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
const identity = (stat: DiskStat): FileIdentity => Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), nlink: Number(stat.nlink) });

/** Component walk, including dangling links. Never normalize away a preceding
 * link before consuming '..'. No realpath shortcut may hide hop exhaustion. */
export function resolveNoLimitsPath(raw: string, options: ResolveOptions = {}): Resolution {
  const path = spellPath(raw, options);
  const lexical = lexicalPath(raw, options);
  const footprint: string[] = [], linkValues: string[] = [];
  const unknown = (cause: string, fixedPrefix?: string): Resolution => Object.freeze({ kind: 'unknown', lexical, cause, fixedPrefix, footprint: Object.freeze([...footprint]), linkValues: Object.freeze([...linkValues]) });
  if (!path || /[\u0000\u0001]/.test(path)) return unknown('unknown-expansion');
  if (options.cwdInvalid && !anchoredPath(path)) return unknown('invalid-cwd');
  if (!anchoredPath(path) && !options.cwd) return unknown('unknown-cwd');
  if (ordinaryStream(path)) return Object.freeze({ kind: 'known', lexical, physical: lexical, exists: true, footprint: Object.freeze([lexical]), linkValues: Object.freeze([]) });
  if (options.remote) return Object.freeze({ kind: 'known', lexical, physical: lexical, exists: false, footprint: Object.freeze([lexical]), linkValues: Object.freeze([]) });
  const disk = options.disk ?? noLimitsDisk;
  const initial = rootAndParts(anchoredPath(path) ? path : `${spellPath(options.cwd!, options)}/${path}`);
  if (!initial.root) return unknown('unanchored-cwd');
  let root = initial.root, names: string[] = [], pending = [...initial.parts];
  let hops = 0, missing = false, finalStat: DiskStat | undefined;
  const current = () => root + names.join('/');
  const followFinal = options.followFinal !== false || /[\\/]$/.test(raw);
  while (pending.length) {
    const part = pending.shift()!;
    if (part === '..') {
      if (missing) return unknown('missing-before-parent', current());
      names.pop(); finalStat = undefined;
      footprint.push(current());
      continue;
    }
    names.push(part);
    const at = current(); footprint.push(at);
    if (!pending.length && followFinal && ordinaryStream(at)) return Object.freeze({ kind: 'known', lexical, physical: at, exists: true, footprint: Object.freeze([...footprint]), linkValues: Object.freeze([...linkValues]) });
    finalStat = undefined;
    if (!missing) {
      try {
        finalStat = disk.lstat(at);
        if (finalStat.isSymbolicLink() && (pending.length > 0 || followFinal)) {
          if (hops >= (options.maxHops ?? 40)) return Object.freeze({ kind: 'exhausted', lexical, hops, footprint: Object.freeze([...footprint]), linkValues: Object.freeze([...linkValues]) });
          hops++;
          // Link contents are filesystem text, never a shell word. Only the
          // platform separator convention applies; '~' stays parent-relative.
          const linkText = disk.readlink(at);
          const target = options.windows || windowsPath(root) ? linkText.replaceAll('\\', '/') : linkText;
          linkValues.push(target);
          names.pop();
          const parsed = rootAndParts(target);
          if (parsed.root) { root = parsed.root; names = []; }
          pending = [...parsed.parts, ...pending]; finalStat = undefined;
          // Exact stream endpoints stay streams even when a link names them.
          // Only empty/dot components were removed; '..' remains ordered.
          const endpoint = root + [...names, ...pending].join('/');
          if (followFinal && ordinaryStream(endpoint)) {
            footprint.push(endpoint);
            return Object.freeze({ kind: 'known', lexical, physical: endpoint, exists: true, footprint: Object.freeze([...footprint]), linkValues: Object.freeze([...linkValues]) });
          }
        } else if (pending.length && !finalStat.isDirectory()) return unknown('non-directory-component', at);
      } catch (error) {
        if (fsCode(error) === 'ENOENT') missing = true;
        else if (fsCode(error) === 'ELOOP') return Object.freeze({ kind: 'exhausted', lexical, hops: 40, footprint: Object.freeze([...footprint]), linkValues: Object.freeze([...linkValues]) });
        else return unknown(`disk-${fsCode(error) ?? 'unavailable'}`, at);
      }
    }
  }
  // A root, or a final '..', has not just passed through lstat.
  if (!missing && !finalStat) {
    try { finalStat = disk.lstat(current()); }
    catch (error) { if (fsCode(error) === 'ENOENT') missing = true; else return unknown(`disk-${fsCode(error) ?? 'unavailable'}`, current()); }
  }
  return Object.freeze({ kind: 'known', lexical, physical: current(), exists: !missing,
    ...(finalStat ? { identity: identity(finalStat), directory: finalStat.isDirectory(), regular: finalStat.isFile() } : {}),
    footprint: Object.freeze([...footprint]), linkValues: Object.freeze([...linkValues]) });
}

export function classifyNoLimitsPath(path: string, context: FsContext = {}): Readonly<{ ruleId: string; protectedClass: string }> | null {
  if (ordinaryStream(path)) return null;
  const system = ownerMarks(() => protectedClass(path));
  if (system) return Object.freeze({ ruleId: 'protected-path', protectedClass: system });
  const gate = gateHit([path]);
  if (gate) return Object.freeze({ ruleId: ruleRowId(gate) ?? gate, protectedClass: 'gate' });
  for (const runtimePath of context.namedProtectedPaths ?? []) {
    const concrete = lexicalPath(runtimePath, context);
    if (pathKey(path) === pathKey(concrete)) return Object.freeze({ ruleId: 'runtime-protected-file', protectedClass: 'gate' });
  }
  return null;
}

export type ProtectedIdentity = Readonly<{ path: string; identity: FileIdentity }>;
/** Mandatory finite registry, rebuilt per inspection/release. No regex scans,
 * nlink blanket, arbitrary cap, or shared cached inode evidence. */
export function protectedIdentityRegistry(context: FsContext = {}, named: readonly string[] = []): readonly ProtectedIdentity[] {
  if (context.remote) return Object.freeze([]);
  const disk = context.disk ?? noLimitsDisk;
  const result: ProtectedIdentity[] = [], seen = new Set<string>();
  const runtimeNames = [...(context.namedProtectedPaths ?? []), ...Object.values(context.runtimePaths ?? {}).filter(path => classifyNoLimitsPath(lexicalPath(path, context), context) !== null)];
  for (const path of noLimitsNamedFiles(context.home ?? homedir(), context.cwd, runtimeNames, named)) {
    const concrete = lexicalPath(path, context), key = pathKey(concrete);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const stat = disk.stat(concrete);
      if (stat.isFile()) result.push(Object.freeze({ path: concrete, identity: identity(stat) }));
    } catch { /* Unavailable data never invents an inode match. */ }
  }
  return Object.freeze(result);
}
export function decisionsForResolution(effect: NativeEffect, resolution: Resolution, context: FsContext = {}, registry: readonly ProtectedIdentity[] = protectedIdentityRegistry(context)): readonly ProtectedDecision[] {
  const operandId = effect.operandId ?? effect.path;
  const lexical = resolution.lexical ?? lexicalPath(effect.path, context);
  const base = { operandId, op: effect.op, lexical, resolution };
  const decisions: ProtectedDecision[] = [];
  for (const path of new Set([lexical, ...(resolution.kind === 'known' ? [resolution.physical] : [])])) {
    const found = classifyNoLimitsPath(path, context);
    if (found) decisions.push(Object.freeze({ ...base, ...found, reason: 'direct-path', ...(resolution.kind === 'known' ? { physical: resolution.physical } : {}) }));
  }
  if (resolution.kind === 'exhausted') decisions.push(Object.freeze({ ...base, reason: 'resolution-exhausted', ruleId: 'resolution-exhausted', protectedClass: 'resolution-exhausted' }));
  if (resolution.kind === 'known' && effect.followFinal && !['delete', 'create-name', 'rename', 'link'].includes(effect.op) && resolution.regular && resolution.identity && resolution.identity.nlink > 1) {
    for (const named of registry) if (named.identity.dev === resolution.identity.dev && named.identity.ino === resolution.identity.ino) {
      decisions.push(Object.freeze({ ...base, reason: 'protected-inode', ruleId: 'protected-inode', protectedClass: 'named-protected-file',
        physical: resolution.physical, identity: resolution.identity, namedProtectedPath: named.path }));
    }
  }
  return Object.freeze(decisions);
}
/** Unknown cwd is only a hold for a named protected suffix. Never invent a
 * physical destination, or treat /etc/** as every possible basename. */
export function unknownCwdSuffixDecisions(effect: NativeEffect, candidates: readonly CwdCandidate[], context: FsContext = {}): readonly ProtectedDecision[] {
  if (!candidates.some(value => value.unknownCause || !value.logical && !value.physical)) return Object.freeze([]);
  const raw = spellPath(effect.path, context);
  if (anchoredPath(raw)) return Object.freeze([]);
  const suffix = protectedCwdSuffix(raw, context.windows ? 'pwsh' : 'posix');
  if (!suffix) return Object.freeze([]);
  return Object.freeze([Object.freeze({
    operandId: effect.operandId ?? effect.path, op: effect.op, lexical: effect.path,
    reason: 'unknown-cwd-protected-suffix' as const, ruleId: suffix.ruleId, protectedClass: suffix.class,
    resolution: Object.freeze({ kind: 'unknown' as const, cause: 'unknown-cwd' }),
    cwdCandidates: Object.freeze(candidates.map(candidate => Object.freeze({ ...candidate, oldpwd: candidate.oldpwd && Object.freeze({ ...candidate.oldpwd }), fixedPrefixes: candidate.fixedPrefixes && Object.freeze([...candidate.fixedPrefixes]), stack: Object.freeze(candidate.stack.map(value => Object.freeze({ ...value }))) }))),
    matchedProtectedSuffix: suffix.matchedSuffix, possibleProtectedName: suffix.possibleProtectedName,
  })]);
}

export function inspectNativeEffects(effects: readonly NativeEffect[], context: FsContext = {}): NativeInspection {
  const named = effects.flatMap(effect => [effect.path, effect.source, effect.targetValue].filter((path): path is string => path !== undefined))
    .map(path => lexicalPath(path, context)).filter(path => classifyNoLimitsPath(path, context) !== null);
  const registry = protectedIdentityRegistry(context, named);
  const judged = effects.map(effect => {
    const frozen = Object.freeze({ ...effect });
    const resolution = resolveNoLimitsPath(effect.path, { ...context, followFinal: effect.followFinal });
    const decisions = [...decisionsForResolution(effect, resolution, context, registry)];
    if (!context.cwd || context.cwdInvalid) decisions.push(...unknownCwdSuffixDecisions(effect, [{ stack: Object.freeze([]), unknownCause: context.cwdInvalid ? 'invalid-cwd' : 'unknown-cwd' }], context));
    if (effect.linkKind === 'hard' && effect.source) {
      const source = resolveNoLimitsPath(effect.source, { ...context, followFinal: effect.sourceFollowFinal !== false });
      for (const found of decisionsForResolution({ ...effect, path: effect.source, op: 'write', followFinal: effect.sourceFollowFinal !== false }, source, context, registry)) {
        decisions.push(Object.freeze({ ...found, reason: 'hard-link-source' as const, lexical: lexicalPath(effect.path, context), sourcePhysical: source.kind === 'known' ? source.physical : undefined }));
      }
    }
    return Object.freeze({ effect: frozen, resolution, decisions: Object.freeze(decisions) });
  });
  const decisions = Object.freeze(judged.flatMap(item => item.decisions));
  return Object.freeze({ verdict: decisions.length ? 'hold' : 'run', decisions, effects: Object.freeze(judged) });
}
