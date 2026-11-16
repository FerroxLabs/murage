// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner-only projection of the shared option grammar back to original Words.
import { literalText, type Word } from './shell/lex.ts';
import { commandRoles, type RoleSlot } from './shell/roles.ts';
import { braceCandidates, candidatesOf, newContext, type SimpleCommand } from './shell/walk.ts';
import { dynamicProducerWord } from './no-limits-producer-values.ts';

export interface OwnerArgumentCommand extends SimpleCommand {
  readonly argumentOrigins: readonly number[];
  readonly argumentExpansionUnknown: boolean;
}

/** Static brace expansion changes argv arity, including source/destination
 * roles. Keep each resulting Word and its original argument index. */
export function ownerArgumentCommand(input: SimpleCommand): OwnerArgumentCommand {
  if ('argumentOrigins' in input) return input as OwnerArgumentCommand;
  const args: Word[] = [], origins: number[] = [], operands: SimpleCommand['operands'] = [];
  let unknown = false;
  for (const [index, word] of input.args.entries()) {
    let variants = [word];
    if (word.parts.some(part => part.kind === 'brace') && !dynamicProducerWord(word)) {
      try { variants = braceCandidates(word); }
      catch { unknown = true; }
    }
    for (const variant of variants) {
      args.push(variant); origins.push(index);
      operands.push(variant === word ? input.operands[index] ?? [] : candidatesOf(variant, newContext()));
    }
  }
  return { ...input, args, operands, argumentOrigins: Object.freeze(origins), argumentExpansionUnknown: unknown };
}

export function roleText(word: Word): string | undefined {
  let text = '';
  for (const part of word.parts) {
    if (part.kind === 'lit' || part.kind === 'glob') text += part.text;
    else if (part.kind === 'tilde') text += '~' + part.user;
    else return undefined;
  }
  return text;
}

/** Offset belongs to the option's original word. Preserve quoting and unknown
 * parts instead of turning an attached expansion into a literal value. */
export function roleWord(word: Word | undefined, offset = 0): Word | undefined {
  if (!word || !offset) return word;
  const literal = literalText(word);
  if (literal !== undefined) return { parts: [{ kind: 'lit', text: literal.slice(offset), quote: 'single' }] };
  let left = offset;
  const parts: Word['parts'] = [];
  for (const part of word.parts) {
    if (!left) { parts.push(part); continue; }
    if (part.kind !== 'lit') return word; // uncertain prefix remains unknown
    if (part.text.length <= left) left -= part.text.length;
    else { parts.push({ ...part, text: part.text.slice(left) }); left = 0; }
  }
  return { parts };
}

/** Ask the shared table whether an unknown part belongs to a known valued
 * option. This retains -e"$body"/--to-command="$body" as code rather than
 * inventing a path operand. Unknown option names remain undefined. */
export function ownerRoleArguments(command: SimpleCommand, dialect: 'posix' | 'pwsh' = 'posix'): Array<string | undefined> {
  const plain = command.args.map(roleText);
  const shapes = command.args.map((word, index) => plain[index] ?? word.parts.map(part =>
    part.kind === 'lit' || part.kind === 'glob' ? part.text : part.kind === 'tilde' ? '~' + part.user : '\u0001').join(''));
  const trial = commandRoles([command.name, ...shapes], dialect);
  const values = new Set(trial.slots.filter(slot => slot.arg > 0 && slot.key && !slot.key.includes('\u0001') && slot.role !== 'flag' && slot.value?.includes('\u0001')).map(slot => slot.arg - 1));
  return plain.map((value, index) => value ?? (values.has(index) ? shapes[index] : undefined));
}
export const ownerCommandRoles = (command: SimpleCommand, dialect: 'posix' | 'pwsh' = 'posix') =>
  commandRoles([command.name, ...ownerRoleArguments(command, dialect)], dialect);
export const slotWord = (command: SimpleCommand, slot: RoleSlot): Word | undefined => roleWord(command.args[slot.arg - 1], slot.offset);
export const optionKey = (slot: RoleSlot): string | undefined => slot.key ??
  (slot.role === 'value' && slot.value?.startsWith('--') ? slot.value.split('=')[0] : undefined);
export const positionalSlots = (slots: readonly RoleSlot[]): RoleSlot[] =>
  slots.filter(slot => slot.arg > 0 && !slot.key && (slot.role === 'read' || slot.role === 'write'));
export const literalRoleValue = (command: SimpleCommand, slot: RoleSlot): string | undefined => {
  const word = slotWord(command, slot);
  return word && literalText(word);
};
