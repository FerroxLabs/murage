// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { homeSpelled, isAnchored, UNKNOWN_MARK, type Candidate } from './shell/walk.ts';
import { archiveRoles, ARCHIVE_PROGRAMS } from './shell/archive-roles.ts';
export { archiveRoles, ARCHIVE_PROGRAMS, type ArchiveRoles, type ArchiveSlotRole, type ArchiveMode } from './shell/archive-roles.ts';

export const isArchiveCommand = (name: string): boolean => ARCHIVE_PROGRAMS.has(name);

/** Project shared operand roles through the walker's candidates. No options
 * are parsed here and no archive or filesystem link is opened. Relative member
 * spellings keep their root and climbs; unknown cwd remains explicitly unknown. */
export function archiveWrites(name: string, args: string[], operands: Candidate[][], cwd: string | undefined): string[] | undefined {
  const plainArgs = args.map((arg, i) => {
    const candidates = operands[i];
    if (candidates?.length === 0 || candidates?.some(item => item.path.startsWith(UNKNOWN_MARK))) return undefined;
    return candidates?.length === 1 && candidates[0]!.kind === 'literal' ? candidates[0]!.path : arg;
  });
  const roles = archiveRoles(name, plainArgs);
  if (!roles) return undefined;
  const values = (index: number): string[] => {
    const slot = roles.slots[index]!;
    return (operands[slot.arg] ?? []).map(item => item.path.replaceAll(UNKNOWN_MARK, '').slice(slot.offset));
  };
  const join = (bases: string[], paths: string[]) => bases.flatMap(base => paths.map(path => isAnchored(homeSpelled(path)) ? path : `${base}/${path}`));
  const rootCache = new Map<number, string[]>([[-1, [cwd ?? '$PWD']]]);
  const rootValues = (index: number): string[] => {
    const chain: number[] = [];
    let pending = index;
    while (!rootCache.has(pending)) {
      chain.push(pending);
      pending = roles.tool === 'tar' ? roles.slots[pending]!.root ?? -1 : -1;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const next = chain[i]!;
      const slot = roles.slots[next]!;
      const paths = values(next);
      // Tar directories are positional and relative to the preceding -C.
      rootCache.set(next, roles.tool === 'tar' ? join(rootCache.get(slot.root ?? -1)!, paths) : paths);
    }
    return rootCache.get(index)!;
  };
  const outputs: string[] = [];
  if (roles.implicitCwdRoot && !roles.stdoutOnly) outputs.push(cwd ?? '$PWD');
  for (const [index, slot] of roles.slots.entries()) {
    if (slot.role !== 'write') continue;
    if (slot.detail === 'extract-root') outputs.push(...rootValues(index));
    else if (slot.detail === 'member-out') outputs.push(...join(rootValues(slot.root ?? -1), values(index)));
    else outputs.push(...values(index).filter(path => slot.detail !== 'archive-out' || path !== '-'));
  }
  return outputs.map(path => cwd === undefined && !isAnchored(homeSpelled(path)) && !path.startsWith('$PWD') ? `$PWD/${path}` : path);
}

// Frozen s1 lane classifier for Full access and other legacy readers.
export const isLegacyArchiveCommand = (name: string): boolean => name === 'tar' || name === 'unzip';

export function legacyArchiveWrites(name: string, args: string[], operands: Candidate[][], cwd: string | undefined): string[] | undefined {
  if (!isLegacyArchiveCommand(name)) return undefined;
  args = args.map((arg, i) => {
    const candidates = operands[i];
    return candidates?.length === 1 && candidates[0]!.kind === 'literal' ? candidates[0]!.path : arg;
  });
  const values = (i: number, offset = 0): string[] => (operands[i] ?? []).map(item => item.path.replaceAll(UNKNOWN_MARK, '').slice(offset));
  // An absent cwd is unknown; it must not become '/' when S1 projects paths.
  let directories = [cwd ?? '$PWD'];
  const archives: string[] = [];
  const outputs: string[] = [];
  const sources: string[] = [];
  const memberDirectories: string[] = [];
  const fromDirectories = (paths: string[]) => directories.flatMap(base => paths.map(path =>
    isAnchored(homeSpelled(path)) ? path : `${base}/${path}`));
  let extract = name === 'unzip', archiveOutput = false, stdout = false, readOnly = false;
  let removeSources = false, options = true;
  const option = (key: string, paths: string[]) => {
    if (key === 'f' || key === '--file') archives.push(...paths);
    if (key === 'C' || key === '--directory') directories = fromDirectories(paths);
    if (name === 'unzip' && key === 'd') directories = paths;
    if (key === '--index-file') outputs.push(...paths);
    if (key === 'T' || key === '--files-from') memberDirectories.push(...directories);
  };
  const members = (i: number) => {
    sources.push(...fromDirectories(values(i)));
    if (name === 'tar') memberDirectories.push(...directories);
  };
  let snapshot: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--' && options) { options = false; continue; }
    if (!options) { members(i); continue; }
    if (name === 'tar' && arg.startsWith('--')) {
      const equal = arg.indexOf('=');
      const key = equal < 0 ? arg : arg.slice(0, equal);
      if (['--create', '--append', '--update', '--concatenate', '--catenate', '--delete'].includes(key)) archiveOutput = true;
      if (key === '--extract' || key === '--get') extract = true;
      if (key === '--to-stdout') stdout = true;
      if (key === '--remove-files') removeSources = true;
      if (['--file', '--directory', '--index-file', '--listed-incremental', '--files-from', '--exclude-from', '--use-compress-program', '--to-command', '--checkpoint-action', '--label', '--format', '--blocking-factor', '--starting-file', '--newer', '--newer-mtime', '--transform', '--strip-components'].includes(key)) {
        const paths = equal < 0 ? values(++i) : values(i, equal + 1);
        option(key, paths);
        if (key === '--listed-incremental') snapshot = paths;
      }
      continue;
    }
    // tar's first option word may omit '-'. In that old form, option values
    // follow the entire option word; dashed options also accept glued values.
    const old = name === 'tar' && i === 0 && /^[A-Za-z]+$/.test(arg);
    if (!old && !arg.startsWith('-')) { members(i); continue; }
    for (let at = old ? 0 : 1; at < arg.length; at++) {
      const key = arg[at]!;
      if (name === 'tar') {
        if ('cruA'.includes(key)) archiveOutput = true;
        if (key === 'x') extract = true;
        if (key === 'O') stdout = true;
      } else if ('ltpvczZ'.includes(key)) readOnly = true;
      const valued = name === 'tar' ? 'fCTXIgbHFKLV'.includes(key) : 'dP'.includes(key);
      if (valued) {
        const attached = !old && at + 1 < arg.length;
        const paths = attached ? values(i, at + 1) : values(++i);
        option(key, paths);
        if (name === 'tar' && key === 'g') snapshot = paths;
        if (!old) break;
      }
    }
  }
  // Only the archive-file role uses '-' for stdin/stdout. In a directory,
  // index or snapshot role it remains a real filesystem destination.
  if (archiveOutput) outputs.push(...archives.filter(path => path !== '-'), ...snapshot);
  if (archiveOutput && removeSources) outputs.push(...sources);
  if (extract && !stdout && !readOnly) {
    outputs.push(...(memberDirectories.length ? memberDirectories : directories));
    // A named tar member can select its own absolute destination (-P), or
    // climb outside its positional -C root. Do not reduce it to that root.
    if (name === 'tar') outputs.push(...sources);
  }
  // Relative side outputs and -d operands also need an unknown cwd spelling;
  // otherwise S1's canonical projection would invent an absolute root.
  return outputs.map(path => cwd === undefined && !isAnchored(homeSpelled(path)) && !path.startsWith('$PWD') ? `$PWD/${path}` : path);
}
