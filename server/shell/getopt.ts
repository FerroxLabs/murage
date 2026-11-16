// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface OptSpec {
  flags?: string;
  valued?: string;
  optional?: string;
  attachedOnly?: string;
  long?: Record<string, 'none' | 'required' | 'optional'>;
  singleDashLong?: boolean;
  oldStyleFirst?: boolean;
  permute?: boolean;
  /** A dash-leading mode starts operands in otherwise explicit option grammars. */
  stopOptions?: (word:string)=>boolean;
}
export interface ParsedArg {
  arg: number;
  offset: number;
  kind: 'flag' | 'value' | 'operand' | 'end' | 'unknown-option';
  key?: string;
  value?: string;
}

/** Lossless option locations. Unknown grammar keeps the operand reading;
 * consumers union its possible writes rather than discarding an operand. */
export function getopt(args: ReadonlyArray<string | undefined>, spec: OptSpec): { items: ParsedArg[]; operands: ParsedArg[]; unknown: boolean } {
  const items: ParsedArg[] = [];
  const operands: ParsedArg[] = [];
  let unknown = false;
  let ended = false;
  const addOperand = (arg: number) => {
    const item: ParsedArg = { arg, offset: 0, kind: 'operand', value: args[arg] };
    items.push(item); operands.push(item);
  };
  const names = Object.keys(spec.long ?? {});
  const resolve = (name: string): string | undefined => {
    const matches = names.filter(key => spec.singleDashLong ? key.toLowerCase().startsWith(name.toLowerCase()) : key.startsWith(name));
    const exact = matches.find(key => spec.singleDashLong ? key.toLowerCase() === name.toLowerCase() : key === name);
    return exact ?? (matches.length === 1 ? matches[0] : undefined);
  };
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === undefined) { unknown = true; addOperand(i); continue; }
    if (ended) { addOperand(i); continue; }
    if (spec.stopOptions?.(word)) { addOperand(i); ended=true; continue; }
    if (word === '--') { items.push({ arg: i, offset: 0, kind: 'end', value: word }); ended = true; continue; }
    const old = i === 0 && spec.oldStyleFirst && /^[A-Za-z]+$/.test(word);
    if (!old && (word === '-' || !word.startsWith('-'))) {
      addOperand(i); if (spec.permute === false) ended = true; continue;
    }
    const prefix = word.startsWith('--') ? 2 : 1;
    if (!old && (prefix === 2 || spec.singleDashLong)) {
      const suffix = word.slice(prefix);
      const eq = spec.singleDashLong ? suffix.search(/[=:]/) : suffix.indexOf('=');
      const name = eq < 0 ? suffix : suffix.slice(0, eq);
      const canonical = resolve(name);
      if (canonical !== undefined) {
        const mode = spec.long![canonical]!;
        const key = word.slice(0, prefix) + canonical;
        if (mode === 'none') {
          if (eq >= 0) unknown = true;
          items.push({ arg: i, offset: prefix, kind: 'flag', key, value: name });
        } else if (eq >= 0) {
          items.push({ arg: i, offset: prefix + eq + 1, kind: 'value', key, value: suffix.slice(eq + 1) }); // M-OPT-LONG-EQ
        } else if (mode === 'optional') {
          items.push({ arg: i, offset: word.length, kind: 'value', key, value: '' });
        } else if (i + 1 < args.length) {
          const value = args[++i];
          if (value === undefined) unknown = true;
          items.push({ arg: i, offset: 0, kind: 'value', key, value });
        } else {
          unknown = true;
          items.push({ arg: i, offset: word.length, kind: 'value', key });
        }
        continue;
      }
      // Single-dash long grammars may still contain real short clusters.
      if (prefix === 2 || ![...(spec.flags ?? '') + (spec.valued ?? '') + (spec.optional ?? '') + (spec.attachedOnly ?? '')].includes(word[1]!)) {
        unknown = true;
        items.push({ arg: i, offset: 0, kind: 'unknown-option', value: word });
        continue;
      }
    }
    const arg = i;
    for (let j = old ? 0 : 1; j < word.length; j++) {
      const letter = word[j]!;
      const key = '-' + letter;
      if (spec.valued?.includes(letter)) {
        if (!old && j + 1 < word.length) {
          items.push({ arg, offset: j + 1, kind: 'value', key, value: word.slice(j + 1) }); // M-OPT-ATTACHED
        } else if (i + 1 < args.length) {
          const value = args[++i];
          if (value === undefined) unknown = true;
          items.push({ arg: i, offset: 0, kind: 'value', key, value });
        } else {
          unknown = true; items.push({ arg, offset: word.length, kind: 'value', key });
        }
        if (!old) break; // M-OPT-CLUSTER
      } else if (spec.optional?.includes(letter) || spec.attachedOnly?.includes(letter)) {
        items.push({ arg, offset: j + 1, kind: 'value', key, value: word.slice(j + 1) });
        break;
      } else if (spec.flags?.includes(letter)) {
        items.push({ arg, offset: j, kind: 'flag', key, value: letter });
      } else {
        unknown = true; items.push({ arg, offset: j, kind: 'unknown-option', key, value: letter });
      }
    }
  }
  return { items, operands, unknown };
}
