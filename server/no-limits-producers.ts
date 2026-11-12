// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner No limits only. Roles describe observed operands; no future filesystem
// entries, successful-operation proofs, or archive contents are simulated.
import type { Word } from './shell/lex.ts';
import { candidatesOf, simpleCommand, type SimpleCommand, type WalkContext } from './shell/walk.ts';
import { archiveRoles, archiveWrites, isArchiveCommand, type ArchiveRoles } from './no-limits-archives.ts';
import { effectiveDestinations, type DestinationPlacement } from './no-limits-placement.ts';
import { anchoredPath, lexicalPath, pathKey, resolveNoLimitsPath, spellPath, type FsContext, type NativeEffect, type ProtectedDecision } from './no-limits-fs.ts';
import { optionKey, ownerArgumentCommand, ownerCommandRoles, ownerRoleArguments, positionalSlots, roleText, roleWord, slotWord } from './no-limits-role-adapter.ts';
import { dynamicProducerWord, producerValues, type ProducerValueBudget } from './no-limits-producer-values.ts';
import { producerParent as parent } from './no-limits-producer-anchors.ts';
import type { DependencyRoot, ProducerOperand } from './no-limits-producer-hazards.ts';

export interface AliasOperation {
  readonly id: string; readonly program: string; readonly family: 'link' | 'relocate' | 'copy' | 'backup' | 'extract';
  readonly operands: readonly ProducerOperand[]; readonly effects: readonly NativeEffect[];
  readonly destinationRoots: readonly DependencyRoot[]; readonly destinationPrefixes: readonly string[];
  readonly unknownDestination: boolean; readonly placement?: DestinationPlacement;
  readonly directDecisions: readonly ProtectedDecision[];
}
export interface ArchiveCommandEffects {
  readonly roles: ArchiveRoles; readonly effects: readonly NativeEffect[];
  readonly operands: readonly ProducerOperand[]; readonly outputs: readonly string[]; readonly receivingOutputs: readonly string[];
}
const norm = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? '';

/** All shared outputs participate even when the archive is create/list/etc.
 * The string projection is never evidence that a raw operand was known. */
export function archiveCommandEffects(id: string, command: SimpleCommand, context: FsContext, walk: WalkContext): ArchiveCommandEffects | undefined {
  const program = norm(command.name);
  if (!isArchiveCommand(program)) return undefined;
  const args = ownerRoleArguments(command);
  const roles = archiveRoles(program, args)!;
  const operands: ProducerOperand[] = [];
  for (const [index, slot] of roles.slots.entries()) {
    // Intermediate -C directories are reads, not extracted contents. The
    // shared classifier already supplies each actual cumulative output root.
    if (!['archive-in', 'archive-out', 'extract-root', 'member-out', 'member-in', 'side-in', 'side-out'].includes(slot.detail)) continue;
    const word = roleWord(command.args[slot.arg], slot.offset);
    const role: ProducerOperand['role'] = slot.detail === 'archive-in' ? 'archive-input' : slot.detail.startsWith('member-') ? 'member' : slot.role === 'write' ? 'destination' : 'source';
    for (const value of producerValues(word, walk, context)) operands.push(Object.freeze({ ...value, id: `${id}:archive:${index}`, role, cwd: context.cwd,
      tree: slot.detail === 'extract-root' }));
  }
  if (roles.implicitCwdRoot) operands.push(Object.freeze({ id: `${id}:archive:implicit-root`, role: 'destination', value: context.cwd, cwd: context.cwd,
    tree: true, ...(!context.cwd ? { unknownCause: 'unknown-cwd' } : {}) }));
  for (const [index, redirect] of command.redirects.entries()) if (redirect.op === '<' && (redirect.fd === undefined || redirect.fd === 0) && redirect.target && !redirect.target.parts.some(part => part.kind === 'procsub')) {
    for (const value of producerValues(redirect.target, walk, context)) operands.push(Object.freeze({ ...value, id: `${id}:archive:stdin:${index}`, role: 'archive-input', cwd: context.cwd }));
  }
  if (command.stdin?.kind === 'file') operands.push(Object.freeze({ id: `${id}:archive:stdin-file`, role: 'archive-input', value: command.stdin.path, cwd: context.cwd }));
  const candidates = command.args.map(word => {
    try { return candidatesOf(word, walk); }
    catch { return [{ kind: 'value' as const, why: 'unavailable-archive-value', path: '\u0001', lead: true }]; }
  });
  const outputs = archiveWrites(program, args.map(arg => arg ?? '\u0001'), candidates, context.cwd) ?? [];
  // Attribute typed effects to the authoritative projection's output order.
  // This uses shared slot metadata and candidate counts only: no archive
  // options or output paths are parsed/classified here. Raw roles above keep
  // unknown provenance even when a variable has a current literal candidate.
  const projectedArgs = args.map((arg, index) => {
    const values = candidates[index]!;
    if (!values.length || values.some(value => value.path.startsWith('\u0001'))) return undefined;
    return values.length === 1 && values[0]!.kind === 'literal' ? values[0]!.path : arg ?? '\u0001';
  });
  const projectedRoles = archiveRoles(program, projectedArgs)!;
  const rootCounts = new Map<number, number>([[-1, 1]]);
  const count = (index: number) => (candidates[projectedRoles.slots[index]!.arg] ?? []).length;
  const rootCount = (index: number): number => {
    const chain: number[] = [];
    while (!rootCounts.has(index)) { chain.push(index); index = projectedRoles.tool === 'tar' ? projectedRoles.slots[index]!.root ?? -1 : -1; }
    for (let i = chain.length - 1; i >= 0; i--) {
      const at = chain[i]!;
      rootCounts.set(at, count(at) * (projectedRoles.tool === 'tar' ? rootCounts.get(projectedRoles.slots[at]!.root ?? -1)! : 1));
    }
    return rootCounts.get(chain[0] ?? index)!;
  };
  const kinds: Array<'write' | 'delete'> = [], receivingIndexes: number[] = [];
  if (projectedRoles.implicitCwdRoot && !projectedRoles.stdoutOnly) { receivingIndexes.push(kinds.length); kinds.push('write'); }
  const extracting = projectedRoles.modes.some(mode => mode === 'extract' || mode === 'pass');
  for (const [index, slot] of projectedRoles.slots.entries()) if (slot.role === 'write') {
    const total = slot.detail === 'extract-root' ? rootCount(index) : slot.detail === 'member-out' ? rootCount(slot.root ?? -1) * count(index) :
      slot.detail === 'archive-out' ? (candidates[slot.arg] ?? []).filter(value => value.path.replaceAll('\u0001', '').slice(slot.offset) !== '-').length : count(index);
    for (let i = 0; i < total; i++) { if(slot.detail === 'extract-root')receivingIndexes.push(kinds.length); kinds.push(slot.detail === 'member-out' && !extracting ? 'delete' : 'write'); }
  }
  const effects = outputs.map((path, index) => {
    const op = kinds.length === outputs.length ? kinds[index]! : 'write';
    return Object.freeze({ operandId: `${id}:archive-output:${index}`, op, path, followFinal: op !== 'delete' });
  });
  return Object.freeze({ roles, operands: Object.freeze(operands), outputs: Object.freeze(outputs), receivingOutputs: Object.freeze(kinds.length === outputs.length ? receivingIndexes.map(index => outputs[index]!) : []), effects: Object.freeze(effects) });
}

/** One operation per collected syntax/location. Caller must gather every
 * destinationRoots entry across the envelope before calling producerHazards. */
export function collectProducer(id: string, input: SimpleCommand, context: FsContext, walk: WalkContext, dialect: 'posix' | 'cmd' | 'pwsh' = 'posix'): AliasOperation | undefined {
  const program = norm(input.name);
  // The archive classifier owns its candidate/argv projection. Other producer
  // grammars consume static brace argv with original argument indexes retained.
  const command = isArchiveCommand(program) ? input : ownerArgumentCommand(input);
  const roles = ownerCommandRoles(command, dialect === 'pwsh' ? 'pwsh' : 'posix');
  const keys = new Set(roles.slots.map(optionKey));
  const has = (...names: string[]) => names.some(name => keys.has(name));
  const endOptions = command.args.findIndex(word => roleText(word) === '--');
  const maySelectOption = (word: Word): boolean => {
    const first = word.parts.find(part => part.kind !== 'lit' || part.text !== '');
    if (first?.kind === 'brace') return first.alts.some(maySelectOption);
    return first?.kind === 'lit' ? first.text.startsWith('-') || first.quote === 'none' && first.text.startsWith('[') : first?.kind !== 'tilde';
  };
  const consumedValues = new Set(roles.slots.filter(slot => slot.key && !slot.key.includes('\u0001') && slot.role !== 'flag').map(slot => slot.arg - 1));
  const dynamicOptions = command.args.some((word, index) => (endOptions < 0 || index < endOptions) && !consumedValues.has(index) && maySelectOption(word) &&
    (dynamicProducerWord(word) || word.parts.some(part => part.kind === 'glob' || part.kind === 'brace' || part.kind === 'lit' && part.quote === 'none' && part.text.includes('['))));
  const editor = ['sed', 'gsed', 'perl', 'ruby'].includes(program);
  const inPlaceSuffix = ['sed', 'gsed', 'perl', 'ruby'].includes(program) && roles.slots.some(slot => ['-i', '--in-place'].includes(slot.key ?? '') && (slot.value !== '' || dynamicProducerWord(slotWord(command, slot) ?? { parts: [] })));
  const backup = (['cp', 'mv', 'ln', 'install', 'rsync'].includes(program) && has('-b', '--backup', '-S', '--suffix', '--backup-dir')) || inPlaceSuffix || editor && dynamicOptions;
  const copyForm = (program === 'cp' && has('-a', '-r', '-R', '-l', '-s', '-P', '-d', '-L', '-H', '--archive', '--recursive', '--symbolic', '--symbolic-link', '--link', '--no-dereference')) || (program === 'rsync' && has('-a', '-r', '-l', '-H', '-L', '-k', '-K', '--archive', '--recursive', '--links', '--hard-links', '--copy-links', '--copy-unsafe-links', '--safe-links', '--keep-dirlinks', '--link-dest', '--copy-dest', '--compare-dest', '--backup-dir'));
  const archive = archiveCommandEffects(id, command, context, walk);
  const windowsCopy = dialect !== 'posix' && ['copy', 'copy-item', 'cpi', 'cp'].includes(program);
  const windowsMove = ['move', 'ren', 'rename', 'move-item', 'mi', 'rename-item', 'rni'].includes(program) || dialect === 'pwsh' && program === 'mv';
  const typeSlot = roles.slots.find(slot => optionKey(slot)?.toLowerCase() === '-itemtype');
  const unknownItemType = !!typeSlot && dynamicProducerWord(slotWord(command, typeSlot) ?? { parts: [] });
  const itemLink = ['new-item', 'ni'].includes(program) && (dynamicOptions || unknownItemType || typeSlot?.value === undefined && !!typeSlot || ['symboliclink', 'junction', 'hardlink'].includes(typeSlot?.value?.toLowerCase() ?? ''));
  let family: AliasOperation['family'] | undefined;
  if (archive?.roles.modes.some(mode => mode === 'extract' || mode === 'pass')) family = 'extract';
  else if (['ln', 'link', 'symlink', 'mklink'].includes(program) || program === 'fsutil' && command.args.slice(0, 2).map(roleText).join(' ').toLowerCase() === 'hardlink create' || itemLink) family = 'link';
  else if (program === 'mv' || windowsMove) family = 'relocate';
  else if (['cp', 'install', 'rsync'].includes(program) || windowsCopy) { if (windowsCopy || copyForm || backup || dynamicOptions) family = 'copy'; }
  else if (backup && roles.known) family = 'backup';
  if (!family) return undefined;

  const operands: ProducerOperand[] = [], effects: NativeEffect[] = [], roots: DependencyRoot[] = [], prefixes: string[] = [];
  const extraDecisions: ProtectedDecision[] = [];
  const wordBudgets = new Map<number, ProducerValueBudget>();
  let unknownDestination = false;
  const addOperand = (role: ProducerOperand['role'], word: Word | undefined, key: string, tree = false, cwd = context.cwd) => {
    const arg = word ? command.args.indexOf(word) : -1;
    const origin = 'argumentOrigins' in command ? (command.argumentOrigins as readonly number[])[arg] : arg;
    let budget = arg < 0 ? undefined : wordBudgets.get(origin!);
    if (arg >= 0 && !budget) { budget = { remaining: 4096 }; wordBudgets.set(origin!, budget); }
    const values = producerValues(word, walk, { ...context, cwd }, budget);
    const added = values.map(value => Object.freeze({ ...value, id: key, role, tree, cwd }));
    operands.push(...added); return added;
  };
  const fixedDirectory = (path: string): string | undefined => {
    const fixed = spellPath(path, context).split('\u0001')[0]!;
    return fixed.endsWith('/') ? fixed.replace(/\/+$/, '') || '/' : fixed.includes('/') ? parent(fixed) : undefined;
  };
  const guaranteedPrefix = (word: Word | undefined): string | undefined => {
    if (!word) return undefined;
    const parts: Word['parts'] = [];
    for (const part of word.parts) { if (part.kind !== 'lit' && part.kind !== 'tilde') break; parts.push(part); }
    if (!parts.length) return undefined;
    const value = producerValues({ parts }, walk, context)[0]?.value;
    return value === undefined ? undefined : parts.length === word.parts.length ? value : fixedDirectory(value + '\u0001');
  };
  const unknownRoot = (cause: string, prefix?: string) => {
    unknownDestination = true;
    roots.push(Object.freeze({ operationId: id, unknownCause: cause }));
    prefixes.push(prefix ? lexicalPath(prefix, context) : context.cwd ? lexicalPath(context.cwd, context) : '*');
    if (prefix) { const physical = resolveNoLimitsPath(prefix, context); if (physical.kind === 'known') prefixes.push(physical.physical); }
  };
  const destination = (path: string | undefined, unknown = false, backupOf?: string, followFinal = false, preservesCwdRoot = false) => {
    if (path === undefined) { unknownRoot('unknown-destination'); return; }
    if (/[\u0001]/.test(path)) { unknownRoot('unknown-destination-value', fixedDirectory(path)); return; }
    const resolution = resolveNoLimitsPath(path, { ...context, followFinal });
    const observed = resolveNoLimitsPath(path, { ...context, followFinal: true });
    if (observed.kind === 'known') prefixes.push(observed.physical, parent(observed.physical));
    const names = [lexicalPath(path, context), ...(resolution.kind === 'known' ? [resolution.physical] : [])];
    for (const name of new Set(names)) {
      roots.push(Object.freeze({ operationId: id, path: name, cwd: context.cwd, ...(preservesCwdRoot ? {preservesCwdRoot:true} : {}), ...(backupOf ? { backupOf } : {}) }));
      prefixes.push(name, parent(name));
    }
    if (resolution.kind !== 'known') unknownRoot(resolution.kind === 'unknown' ? resolution.cause : 'resolution-exhausted', resolution.kind === 'unknown' ? resolution.fixedPrefix : undefined);
    if (unknown) unknownRoot('unknown-destination-value');
  };
  const effect = (operand: ProducerOperand, op: NativeEffect['op'], followFinal: boolean) => {
    if (operand.value !== undefined) effects.push(Object.freeze({ operandId: operand.id, path: operand.value, op, followFinal, ...(operand.tree ? { recursive: true } : {}) }));
    else effects.push(Object.freeze({ operandId: operand.id, path: '\u0001', op, followFinal }));
  };
  const placement = dialect === 'posix' ? effectiveDestinations(command, context, walk) : undefined;
  // Rsync resolves basis/backup options in the receiver, including a renamed
  // single-file destination whose receiving directory is its parent.
  const receivingCwds = program === 'rsync' && placement ? placement.receiverDirectories.map(receiver =>
    anchoredPath(receiver) ? receiver : context.cwd ? receiver === '.' ? context.cwd : `${context.cwd}/${receiver}` : undefined
  ) : [context.cwd];
  if (archive) {
    operands.push(...archive.operands); effects.push(...archive.effects);
    for (const [index, path] of archive.outputs.entries()) {
      destination(path, false, undefined, true, archive.receivingOutputs.includes(path));
      operands.push(Object.freeze({ id: `${id}:archive:projected:${index}`, role: 'destination', value: path, cwd: context.cwd, tree: true }));
    }
    if (archive.roles.unknownOptions) operands.push(Object.freeze({ id: `${id}:archive:unknown-options`, role: 'destination', unknownCause: 'unknown-archive-options', cwd: context.cwd }));
    // Preserve unknown extraction roots/member names despite projection's
    // UNKNOWN_MARK removal, including their resulting possible write.
    for (const operand of archive.operands) if (operand.role === 'destination' || operand.role === 'member') {
      if (operand.unknownCause && !archive.roles.stdoutOnly) { unknownRoot(operand.unknownCause); if (operand.role === 'destination') effect(operand, 'write', true); }
    }
  } else if (placement) {
    const symbolic = program === 'ln' && has('-s', '--symbolic', '--symbolic-link');
    for (const source of placement.sourceWords) addOperand(symbolic ? 'target' : 'source', source.word, `${id}:source:${source.index}`, symbolic || family === 'relocate' || family === 'copy');
    addOperand('destination', placement.destinationWord, `${id}:destination`);
    for (const item of placement.destinations) {
      destination(item.path, false, undefined, item.followFinal);
      operands.push(Object.freeze({ id: `${id}:effective:${item.effect.operandId}`, role: 'destination', value: item.path, cwd: context.cwd, tree: family === 'copy' || family === 'relocate' }));
      const hard = program === 'ln' && !symbolic || program === 'cp' && has('-l', '--link');
      effects.push(Object.freeze({ ...item.effect, operandId: `${id}:${item.effect.operandId}`,
        ...(hard ? { linkKind: 'hard', sourceFollowFinal: program === 'ln' ? has('-L', '--logical') : !has('-P', '-d', '--no-dereference') } : {}),
        ...(symbolic ? { linkKind: 'symbolic', targetValue: item.source } : {}),
      }));
    }
    for (const directory of placement.directoryOperands) {
      const lexical = lexicalPath(directory, context); prefixes.push(lexical, parent(lexical));
    }
    if (placement.unknown) {
      unknownRoot(placement.unknownCauses.join(','), dynamicOptions ? undefined : guaranteedPrefix(placement.destinationWord));
      if (!placement.destinations.length) for (const operand of operands.filter(operand => operand.role === 'destination')) effect(operand, 'create-name', false);
    }
    if (family === 'relocate') for (const source of operands.filter(operand => operand.role === 'source')) effect(source, 'delete', false);
    const parents = [...new Set(roots.flatMap(root => root.path ? [parent(root.path)] : []))];
    if (symbolic) for (const target of [...operands].filter(operand => operand.role === 'target')) for (const path of parents) if (target.value !== undefined) {
      operands.push(Object.freeze({ ...target, id: target.id + ':link-parent:' + path, cwd: path }));
    }
  } else if (program === 'mklink' || program === 'fsutil' || program === 'link' || program === 'symlink') {
    const args = command.args;
    const offset = program === 'fsutil' ? 2 : program === 'mklink' && ['/D', '/J', '/H'].includes(roleText(args[0] ?? { parts: [] })?.toUpperCase() ?? '') ? 1 : 0;
    const reversed = program === 'mklink' || program === 'fsutil';
    const dest = addOperand('destination', args[offset + (reversed ? 0 : 1)], `${id}:destination`);
    const symbolic = program === 'symlink' || program === 'mklink' && roleText(args[0] ?? { parts: [] })?.toUpperCase() !== '/H';
    const targets = addOperand('target', args[offset + (reversed ? 1 : 0)], `${id}:target`, symbolic);
    for (const operand of dest) { destination(operand.value, !!operand.unknownCause); effect(operand, 'create-name', false); }
    const parents = [...new Set(roots.flatMap(root => root.path ? [parent(root.path)] : []))];
    if (symbolic) for (const target of targets) for (const path of parents) operands.push(Object.freeze({ ...target, id: target.id + ':link-parent:' + path, cwd: path }));
  } else if (itemLink || windowsMove || windowsCopy) {
    const positional = positionalSlots(roles.slots);
    const pathSlots = roles.slots.filter(slot => ['-path', '-literalpath'].includes(optionKey(slot)?.toLowerCase() ?? ''));
    const destSlots = roles.slots.filter(slot => ['-destination', '-newname'].includes(optionKey(slot)?.toLowerCase() ?? ''));
    const targetSlots = roles.slots.filter(slot => ['-target', '-value'].includes(optionKey(slot)?.toLowerCase() ?? ''));
    const sources = pathSlots.length ? pathSlots : dialect === 'cmd' ? positional.slice(0, -1) : positional.slice(0, 1);
    const destinations = family === 'link' ? sources : destSlots.length ? destSlots : dialect === 'cmd' ? positional.slice(-1) : positional.slice(1, 2);
    const targets = targetSlots.length ? targetSlots : family === 'link' ? positional.slice(pathSlots.length ? 0 : 1, pathSlots.length ? 1 : 2) : [];
    // Pipeline paths need the same source-tree and effective-child inspection
    // as argument paths, before any destination is placed.
    const input = command.stdin;
    const pipelineWords: Word[] = !sources.length && family !== 'link' && input?.kind === 'literal'
      ? input.words.length ? input.words : input.text.split(/\r?\n/).filter(Boolean).map(text => ({ parts: [{ kind: 'lit', text, quote: 'single' }] })) : [];
    const sourceWords = [...sources.flatMap(source => { const value = slotWord(command, source); return value ? [value] : []; }), ...pipelineWords];
    if (family !== 'link') for (const slot of sources) {
      const added = addOperand('source', slotWord(command, slot), `${id}:source:${slot.arg}`, true);
      if (family === 'relocate') for (const operand of added) effect(operand, 'delete', false);
    }
    if (!sources.length && family !== 'link') {
      if (pipelineWords.length) for (const [index, word] of pipelineWords.entries()) {
        const added = addOperand('source', word, `${id}:pipeline-source:${index}`, true);
        if (family === 'relocate') for (const operand of added) effect(operand, 'delete', false);
      } else addOperand('source', undefined, `${id}:pipeline-source`, true);
    }
    for (const slot of targets) addOperand('target', slotWord(command, slot), `${id}:target:${slot.arg}`, family === 'link' && typeSlot?.value?.toLowerCase() !== 'hardlink');
    for (const slot of destinations) {
      const word = slotWord(command, slot);
      let added = addOperand('destination', word, `${id}:destination:${slot.arg}`);
      const nameSlot = roles.slots.find(value => value.key?.toLowerCase() === '-name');
      if (family === 'link' && nameSlot) {
        const names = producerValues(slotWord(command, nameSlot), walk, context);
        added = added.flatMap(operand => names.map(name => Object.freeze({ ...operand, value: operand.value === undefined || name.value === undefined ? undefined : operand.value.replace(/[\\/]$/, '') + '/' + name.value, ...(name.unknownCause ? { unknownCause: name.unknownCause } : {}) })));
        operands.push(...added);
      }
      const renaming = ['ren', 'rename', 'rename-item', 'rni'].includes(program);
      if (family !== 'link' && !renaming && sourceWords.length && word) {
        const recurse = roles.slots.some(value => value.key?.toLowerCase() === '-recurse');
        const recursiveFlag: Word[] = recurse ? [{ parts: [{ kind: 'lit', text: '-R', quote: 'single' }] }] : [];
        const semantic = simpleCommand(family === 'relocate' ? 'mv' : 'cp', [...recursiveFlag, { parts: [{ kind: 'lit', text: '--', quote: 'single' }] }, ...sourceWords, word], walk);
        const placed = effectiveDestinations(semantic, context, walk, undefined, pipelineWords.length > 0)!;
        extraDecisions.push(...placed.decisions);
        for (const item of placed.destinations) {
          destination(item.path, false, undefined, item.followFinal);
          operands.push(Object.freeze({ id: `${id}:effective:${item.effect.operandId}`, role: 'destination', value: item.path, cwd: context.cwd, tree: true }));
          effects.push(Object.freeze({ ...item.effect, operandId: `${id}:${item.effect.operandId}` }));
        }
        if (placed.unknown) unknownRoot(placed.unknownCauses.join(','));
        if (placed.destinations.length) continue;
      }
      for (const operand of added) {
        // Rename's NewName is relative to each source parent, not cwd.
        const source = operands.find(value => value.role === 'source');
        const path = renaming && source?.value && operand.value ? parent(lexicalPath(source.value, context)) + '/' + basename(operand.value) : operand.value;
        destination(path, !!operand.unknownCause); effect({ ...operand, value: path }, 'create-name', false);
      }
    }
    if (!destinations.length) unknownRoot('unavailable-pipeline-destination');
    if (family === 'link' && !targets.length) addOperand('target', undefined, `${id}:missing-target`);
    const parents = [...new Set(roots.flatMap(root => root.path ? [parent(root.path)] : []))];
    if (family === 'link' && typeSlot?.value?.toLowerCase() !== 'hardlink') for (const target of [...operands].filter(value => value.role === 'target')) for (const path of parents) operands.push(Object.freeze({ ...target, id: target.id + ':link-parent:' + path, cwd: path }));
  } else {
    // Shared roles exclude sed/perl scripts, expressions and option values.
    for (const slot of roles.slots.filter(slot => slot.role === 'write' || editor && dynamicOptions && slot.role === 'read' && !slot.key)) {
      const added = addOperand('source', slotWord(command, slot), `${id}:backup-source:${slot.arg}`);
      for (const operand of added) { destination(operand.value, !!operand.unknownCause); effect(operand, 'write', true); }
    }
    if (editor && dynamicOptions) {
      const unknown = addOperand('backup', undefined, `${id}:unknown-editor-output`)[0]!;
      effect(unknown, 'write', true); unknownRoot('unknown-editor-backup');
    }
  }

  if (family === 'link' && !placement) {
    const hard = program === 'fsutil' || program === 'mklink' && roleText(command.args[0] ?? { parts: [] })?.toUpperCase() === '/H' || typeSlot?.value?.toLowerCase() === 'hardlink' || program === 'link';
    const target = operands.find(operand => operand.role === 'target');
    if (hard && target?.value) for (let index = 0; index < effects.length; index++) {
      if (effects[index]!.op === 'create-name') effects[index] = Object.freeze({ ...effects[index]!, source: target.value, linkKind: 'hard', sourceFollowFinal: true });
    }
  }

  // Extra source trees and backup locations come from option slots, never a
  // second option tokenizer. Raw variables survive even if currently bound.
  for (const slot of roles.slots) if (['--link-dest', '--copy-dest', '--compare-dest'].includes(slot.key ?? '')) {
    for (const cwd of receivingCwds) addOperand('source', slotWord(command, slot), `${id}:link-base:${slot.arg}`, true, cwd);
  }
  if (backup) {
    const suffixSlots = roles.slots.filter(slot => ['-S', '--suffix', '-i', '--in-place'].includes(slot.key ?? ''));
    // A suffix is text, not an independent filename relative to cwd. Preserve
    // unknown provenance here; inspect the actual combined backup paths below.
    for (const slot of suffixSlots) for (const value of producerValues(slotWord(command, slot), walk, context)) if (value.unknownCause || value.value === undefined) {
      operands.push(Object.freeze({ id: `${id}:backup-suffix:${slot.arg}`, role: 'backup', rawValue: value.value, unknownCause: value.unknownCause ?? 'unknown-backup-suffix', cwd: context.cwd }));
    }
    const backupDestinations = [...roots].filter(root => root.path);
    const backupDirs = roles.slots.filter(slot => slot.key === '--backup-dir');
    for (const slot of backupDirs) for (const cwd of receivingCwds) for (const operand of addOperand('backup', slotWord(command, slot), `${id}:backup-dir:${slot.arg}`, true, cwd)) {
      const value = operand.value === undefined ? undefined : spellPath(operand.value, context);
      const path = value === undefined ? undefined : anchoredPath(value) ? value : cwd ? `${cwd}/${value}` : operand.value;
      destination(path, !!operand.unknownCause); effect({ ...operand, value: path }, 'create-name', false);
    }
    const suffixSlot = suffixSlots.at(-1);
    const suffixes = suffixSlot ? producerValues(slotWord(command, suffixSlot), walk, context) : [{ value: '~' }];
    for (const root of backupDirs.length ? [] : backupDestinations) for (const suffix of suffixes) {
      if (suffix.value === undefined || suffix.unknownCause) { unknownRoot(suffix.unknownCause ?? 'unknown-backup-suffix'); continue; }
      // A suffix is text, so a quoted leading '~' marker is not a path marker.
      const path = root.path! + suffix.value.replace(/^\u0000/, '');
      destination(path);
      operands.push(Object.freeze({ id: `${id}:backup-path:${path}`, role: 'backup', value: path, cwd: context.cwd }));
      if (!suffixSlot) roots.push(Object.freeze({ operationId: id, path: root.path, backupOf: root.path, cwd: context.cwd }));
      effects.push(Object.freeze({ operandId: `${id}:backup:${path}`, path, op: 'create-name', followFinal: false }));
    }
  }
  if (dynamicOptions) operands.push(Object.freeze({ id: `${id}:unknown-options`, role: 'destination', unknownCause: 'unknown-producer-options', cwd: context.cwd }));
  if (unknownItemType || roles.slots.some(slot => slot.key === '--backup' && dynamicProducerWord(slotWord(command, slot) ?? { parts: [] }))) operands.push(Object.freeze({ id: `${id}:unknown-mode`, role: 'target', unknownCause: 'unknown-producer-mode', cwd: context.cwd }));
  if (!roots.length && effects.length) unknownRoot('unknown-destination');
  return Object.freeze({ id, program, family, operands: Object.freeze(operands), effects: Object.freeze(effects), destinationRoots: Object.freeze(roots),
    destinationPrefixes: Object.freeze([...new Map(prefixes.map(path => [pathKey(path, context.windows), path])).values()]), unknownDestination,
    ...(placement ? { placement } : {}), directDecisions: Object.freeze([...(placement?.decisions ?? []), ...extraDecisions]) });
}
