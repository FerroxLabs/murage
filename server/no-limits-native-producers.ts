// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { inspectNativeEffects, lexicalPath, pathKey, resolveNoLimitsPath, spellPath, type FsContext, type NativeEffect } from './no-limits-fs.ts';
import { producerParent } from './no-limits-producer-anchors.ts';
import type { DependencyRoot, ProducerOperand } from './no-limits-producer-hazards.ts';
import type { AliasOperation } from './no-limits-producers.ts';

/** Exact typed effects only. A native batch is its own envelope; no shell
 * syntax, option guessing or command text is manufactured for it. */
export function collectNativeProducer(id: string, effect: NativeEffect, context: FsContext = {}): AliasOperation | undefined {
  const family = effect.op === 'rename' ? 'relocate' : effect.linkKind || effect.op === 'link' ? 'link' : effect.op === 'copy' && effect.recursive ? 'copy' : undefined;
  if (family === undefined) return undefined;
  const operands: ProducerOperand[] = [], effects: NativeEffect[] = [Object.freeze({ ...effect })];
  const roots: DependencyRoot[] = [], prefixes: string[] = [];
  const add = (role: ProducerOperand['role'], value: string | undefined, suffix: string, tree = false, cwd = context.cwd) => {
    const operand = Object.freeze({ id: `${id}:${suffix}`, role, value, tree, cwd, ...(value === undefined ? { unknownCause: 'missing-native-operand' } : {}) });
    operands.push(operand); return operand;
  };
  const sourceRole = effect.linkKind === 'hard' || family !== 'link' ? 'source' : 'target';
  const sourceValue = family === 'link' && effect.linkKind !== 'hard' ? effect.targetValue ?? effect.source : effect.source;
  const source = add(sourceRole, sourceValue, 'source', family !== 'link' || effect.linkKind !== 'hard');
  add('destination', effect.path, 'destination', family !== 'link');
  if (family === 'relocate' && effect.source !== undefined) effects.push(Object.freeze({ operandId: `${id}:source-removal`, op: 'delete', path: effect.source, followFinal: false, recursive: effect.recursive }));
  if (family === 'link' && !effect.linkKind) operands.push(Object.freeze({ id: `${id}:link-kind`, role: 'target', unknownCause: 'unknown-native-link-kind', cwd: context.cwd }));

  const actual = resolveNoLimitsPath(effect.path, { ...context, followFinal: effect.followFinal });
  const observed = resolveNoLimitsPath(effect.path, { ...context, followFinal: true });
  const marked = effect.path.includes('\u0001');
  if (!marked) for (const path of new Set([lexicalPath(effect.path, context), ...(actual.kind === 'known' ? [actual.physical] : [])])) {
    roots.push(Object.freeze({ operationId: id, path, cwd: context.cwd }));
    prefixes.push(path, producerParent(path));
    if (source.role === 'target' && source.value !== undefined) operands.push(Object.freeze({ ...source, id: `${id}:link-parent:${path}`, cwd: producerParent(path) }));
  }
  if (observed.kind === 'known' && !marked) prefixes.push(observed.physical, producerParent(observed.physical));
  const unknownDestination = marked || actual.kind !== 'known';
  if (unknownDestination) {
    roots.push(Object.freeze({ operationId: id, unknownCause: actual.kind === 'unknown' ? actual.cause : 'unknown-native-destination' }));
    const fixed = marked ? spellPath(effect.path, context).split('\u0001')[0]! : undefined;
    const prefix = fixed?.includes('/') ? fixed.endsWith('/') ? fixed.replace(/\/+$/, '') || '/' : producerParent(fixed) :
      actual.kind === 'unknown' ? actual.fixedPrefix : undefined;
    prefixes.push(prefix ? lexicalPath(prefix, context) : context.cwd && !context.cwdInvalid ? lexicalPath(context.cwd, context) : '*');
  }
  return Object.freeze({
    id, program: 'native', family,
    operands: Object.freeze(operands),
    effects: Object.freeze(effects),
    destinationRoots: Object.freeze(roots),
    destinationPrefixes: Object.freeze([...new Map(prefixes.map(path => [pathKey(path, context.windows), path])).values()]),
    unknownDestination,
    directDecisions: inspectNativeEffects(effects, context).decisions,
  });
}

export function collectNativeProducers(id: string, effects: readonly NativeEffect[], context: FsContext = {}): readonly AliasOperation[] {
  return Object.freeze(effects.flatMap((effect, index) => {
    const operation = collectNativeProducer(`${id}:${index}:${effect.operandId ?? 'effect'}`, effect, context);
    return operation ? [operation] : [];
  }));
}
