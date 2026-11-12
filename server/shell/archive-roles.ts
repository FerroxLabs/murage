// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { getopt, type OptSpec, type ParsedArg } from './getopt.ts';

export type ArchiveTool = 'tar' | 'unzip' | 'cpio' | '7z';
export type ArchiveMode = 'extract' | 'create' | 'append' | 'update' | 'delete' | 'list' | 'test' | 'diff' | 'pass' | 'none';
export type ArchiveSlotRole = 'archive-in' | 'archive-out' | 'extract-root' | 'member-out' | 'member-in' | 'side-out' | 'side-in' | 'chdir-read' | 'program' | 'value' | 'flag';
export interface ArchiveRoles {
  tool: ArchiveTool;
  program: string;
  modes: ArchiveMode[];
  slots: Array<{
    arg: number; offset: number; value: string | undefined;
    role: 'name' | 'write' | 'read' | 'command' | 'script' | 'value' | 'flag';
    key?: string; detail: ArchiveSlotRole; root?: number;
  }>;
  implicitCwdRoot: boolean;
  stdoutOnly: boolean;
  unknownOptions: boolean;
}
export const ARCHIVE_PROGRAMS: ReadonlySet<string> = new Set(['tar', 'gtar', 'bsdtar', 'unzip', 'cpio', '7z', '7za', '7zr', '7zz']);
const tarModes: Record<string, ArchiveMode> = {
  '-x': 'extract', '--extract': 'extract', '--get': 'extract', '-c': 'create', '--create': 'create',
  '-r': 'append', '--append': 'append', '-u': 'update', '--update': 'update', '-A': 'append',
  '--catenate': 'append', '--concatenate': 'append', '--delete': 'delete', '-t': 'list', '--list': 'list',
  '-d': 'diff', '--diff': 'diff', '--compare': 'diff',
};
const tarSpec: OptSpec = {
  flags: 'xc rutdAOPvzhjJMspakmwS'.replaceAll(' ', ''), valued: 'fCTXIgbHFKLVN', oldStyleFirst: true,
  long: {
    ...Object.fromEntries(Object.keys(tarModes).filter(key => key.startsWith('--')).map(key => [key.slice(2), 'none' as const])),
    'to-stdout': 'none', 'remove-files': 'none', 'absolute-names': 'none', 'multi-volume': 'none',
    file: 'required', directory: 'required', cd: 'required', 'index-file': 'required', 'listed-incremental': 'required',
    'files-from': 'required', 'exclude-from': 'required', 'use-compress-program': 'required', 'to-command': 'required',
    'info-script': 'required', 'checkpoint-action': 'required', 'rsh-command': 'required', label: 'required', format: 'required',
    'blocking-factor': 'required', 'starting-file': 'required', 'tape-length': 'required', newer: 'required',
    'newer-mtime': 'required', transform: 'required', 'strip-components': 'required',
  },
};
const unzipSpec: OptSpec = { flags: 'ltpvczZonfuj aqCLX:^x'.replaceAll(' ', ''), valued: 'dP' };
const cpioSpec: OptSpec = {
  flags: 'ioptadmuvBck0A', valued: 'FOIDEHCMR',
  long: { extract: 'none', create: 'none', 'pass-through': 'none', list: 'none', file: 'required', directory: 'required',
    'pattern-file': 'required', format: 'required', 'io-size': 'required', message: 'required', owner: 'required', 'rsh-command': 'required' },
};
const sevenSpec: OptSpec = {
  flags: 'yr', attachedOnly: 'owipxtm', singleDashLong: true,
  long: { so: 'none', sdel: 'none', ao: 'optional', },
};
const writeDetail = (detail: ArchiveSlotRole) => ['archive-out', 'side-out', 'extract-root', 'member-out'].includes(detail);
const readDetail = (detail: ArchiveSlotRole) => ['archive-in', 'member-in', 'side-in', 'chdir-read'].includes(detail);

/** Option grammar lives here and in getopt, never in the readers. Slot locations
 * refer to args before quote removal/expansion so every reader uses the same roles. */
function classify(program: string, args: ReadonlyArray<string | undefined>, bsd = false, modeOverride?: ArchiveMode, unknownAsFlag = false): ArchiveRoles | undefined {
  if (!ARCHIVE_PROGRAMS.has(program)) return undefined;
  const tool: ArchiveTool = program.endsWith('tar') ? 'tar' : program === 'unzip' ? 'unzip' : program === 'cpio' ? 'cpio' : '7z';
  const parsed = getopt(args, tool === 'tar' ? { ...tarSpec, valued: tarSpec.valued! + (bsd ? 's' : '') } : tool === 'unzip' ? unzipSpec : tool === 'cpio' ? cpioSpec : sevenSpec);
  const has = (...keys: string[]) => parsed.items.some(item => keys.includes(item.key ?? ''));
  let mode: ArchiveMode = 'none';
  if (tool === 'tar') mode = parsed.items.map(item => tarModes[item.key ?? '']).find(Boolean) ?? 'none';
  if (tool === 'unzip') mode = has('-l', '-v', '-Z', '-z') ? 'list' : has('-t') ? 'test' : 'extract';
  if (tool === 'cpio') mode = has('-t', '--list') ? 'list' : has('-i', '--extract') ? 'extract' : has('-o', '--create') ? 'create' : has('-p', '--pass-through') ? 'pass' : 'none';
  const sevenCommand = tool === '7z' ? parsed.operands[0] : undefined;
  if (tool === '7z') mode = ({ x: 'extract', e: 'extract', a: 'create', u: 'update', rn: 'update', d: 'delete', l: 'list', t: 'test' } as Record<string, ArchiveMode>)[sevenCommand?.value ?? ''] ?? 'none';
  mode = modeOverride ?? mode;
  const output = ['create', 'append', 'update', 'delete'].includes(mode);
  const extracting = mode === 'extract' || mode === 'pass';
  const stdoutOnly = mode === 'extract' && (tool === 'tar' ? has('-O', '--to-stdout') : tool === 'unzip' ? has('-p', '-c') : tool === '7z' && has('-so'));
  const result: ArchiveRoles = { tool, program, modes: [mode], slots: [], implicitCwdRoot: false, stdoutOnly, unknownOptions: parsed.unknown };
  const add = (item: ParsedArg, detail: ArchiveSlotRole, root?: number): number => {
    const index = result.slots.length;
    result.slots.push({ arg: item.arg, offset: item.offset, value: item.value, key: item.key, detail, root,
      role: writeDetail(detail) ? 'write' : readDetail(detail) ? 'read' : detail === 'program' ? 'command' : detail === 'flag' ? 'flag' : 'value' });
    return index;
  };
  let root = -1, memberCount = 0, archiveSeen = false, excluded = false;
  const usedRoots = new Set<number>();
  const markRoot = () => { usedRoots.add(root); };
  // unzip/7z root switches apply globally, even when they follow member names.
  let globalRoot: ParsedArg | undefined;
  if (tool === 'unzip' || tool === '7z') globalRoot = parsed.items.filter(item => item.key === (tool === 'unzip' ? '-d' : '-o')).at(-1);
  if (globalRoot) root = add(globalRoot, extracting ? 'extract-root' : 'chdir-read');
  const unknownOperands = new Set(parsed.operands.filter(item => item.value === undefined).map(item => item.arg));
  for (const item of parsed.items) {
    if (item === globalRoot) continue;
    const key = item.key ?? '';
    if (item.kind === 'operand') {
      if (item.value === undefined && (modeOverride !== undefined || unknownAsFlag)) { add(item, 'flag'); continue; }
      if (output && (modeOverride !== undefined || unknownAsFlag) && unknownOperands.has(item.arg - 1) && (tool === 'tar' || tool === 'cpio')) add(item, 'archive-out');
      if (tool === '7z' && item === sevenCommand) { add(item, 'value'); continue; }
      if ((tool === 'unzip' || tool === '7z') && !archiveSeen) { archiveSeen = true; add(item, output ? 'archive-out' : 'archive-in'); continue; }
      if (tool === 'cpio') {
        if (mode === 'pass') { add(item, 'extract-root'); memberCount++; }
        else add(item, 'value');
        continue;
      }
      if (tool === 'unzip' && excluded) { add(item, 'value'); continue; }
      const removal = output && (has('--remove-files') || tool === '7z' && has('-sdel'));
      add(item, extracting || removal ? 'member-out' : 'member-in', root);
      memberCount++;
      if (extracting || removal) markRoot();
      continue;
    }
    if (item.kind !== 'value') {
      add(item, item.kind === 'flag' ? 'flag' : 'value');
      if (tool === 'unzip') excluded = key === '-x';
      continue;
    }
    if (tool === 'tar') {
      if (['-f', '--file'].includes(key)) add(item, output ? 'archive-out' : 'archive-in');
      else if (['-C', '--directory', '--cd'].includes(key)) root = add(item, 'chdir-read', root);
      else if (key === '--index-file') add(item, 'side-out');
      else if (['-g', '--listed-incremental'].includes(key)) add(item, output ? 'side-out' : 'side-in');
      else if (['-T', '--files-from', '-X', '--exclude-from'].includes(key)) { add(item, 'side-in'); if (extracting && ['-T', '--files-from'].includes(key)) { memberCount++; markRoot(); } }
      else if (['-I', '--use-compress-program', '--to-command', '-F', '--info-script', '--checkpoint-action', '--rsh-command'].includes(key)) add(item, 'program', root);
      else add(item, 'value');
    } else if (tool === 'unzip') { add(item, key === '-d' ? 'chdir-read' : 'value'); excluded = false; }
    else if (tool === 'cpio') {
      if (['-F', '--file'].includes(key)) add(item, output ? 'archive-out' : 'archive-in');
      else if (key === '-O') add(item, output ? 'archive-out' : 'value');
      else if (key === '-I') add(item, 'archive-in');
      else if (['-D', '--directory'].includes(key)) root = add(item, 'chdir-read', root);
      else add(item, ['-E', '--pattern-file'].includes(key) ? 'side-in' : key === '--rsh-command' ? 'program' : 'value', root);
    } else add(item, key === '-w' ? 'side-out' : 'value');
  }
  if (extracting && !memberCount) markRoot();
  for (const index of usedRoots) {
    if (index < 0) { if (extracting) result.implicitCwdRoot = true; continue; }
    const slot = result.slots[index]!;
    if (extracting) { slot.detail = 'extract-root'; slot.role = 'write'; }
  }
  if (stdoutOnly) result.implicitCwdRoot = false;
  if (stdoutOnly) for (const slot of result.slots) if (slot.detail === 'extract-root' || slot.detail === 'member-out') slot.role = 'read';
  return result;
}

/** GNU and BSD disagree about -s. Keep the union, with root references
 * remapped to the shared slot array. No reader chooses its own tar dialect. */
export function archiveRoles(program: string, args: ReadonlyArray<string | undefined>): ArchiveRoles | undefined {
  const result = classify(program, args);
  if (!result) return undefined;
  const readings: ArchiveRoles[] = result.tool === 'tar' ? [classify(program, args, true)!] : [];
  if (args.some(arg => arg === undefined)) {
    // G1: the same unknown word can be an operand or an option. Keep both
    // readings, including a following value consumed as an archive output.
    readings.push(classify(program, args, false, undefined, true)!);
    const unknownSlots = result.slots.filter(slot => slot.value === undefined && slot.key === undefined);
    const firstMode = result.slots.find(slot => tarModes[slot.key ?? ''])?.arg ?? Infinity;
    const unknownMode = result.tool === 'tar' ? unknownSlots.some(slot => slot.arg < firstMode)
      : result.tool === 'cpio' ? result.modes[0] === 'none' && unknownSlots.length > 0
      : result.tool === '7z' && getopt(args, sevenSpec).operands[0]?.value === undefined;
    if (unknownMode) {
      const modes: ArchiveMode[] = result.tool === 'cpio' ? ['extract', 'create', 'pass'] : ['extract', 'create'];
      for (const mode of modes) {
        readings.push(classify(program, args, false, mode, true)!);
        if (result.tool === 'tar') readings.push(classify(program, args, true, mode, true)!);
      }
    }
  }
  const identity = (slot: ArchiveRoles['slots'][number]) => JSON.stringify([slot.arg, slot.offset, slot.detail, slot.role, slot.root, slot.key]);
  const identities = new Map(result.slots.map((slot, index) => [identity(slot), index]));
  for (const reading of readings) {
    const remap = new Map<number, number>();
    for (const [index, slot] of reading.slots.entries()) {
      const root = slot.root === undefined || slot.root < 0 ? slot.root : remap.get(slot.root);
      const mapped = { ...slot, root };
      const key = identity(mapped);
      let existing = identities.get(key);
      if (existing === undefined) { existing = result.slots.length; result.slots.push(mapped); identities.set(key, existing); }
      remap.set(index, existing);
    }
    result.modes = [...new Set([...result.modes, ...reading.modes])];
    result.implicitCwdRoot ||= reading.implicitCwdRoot;
    result.unknownOptions ||= reading.unknownOptions;
  }
  return result;
}
