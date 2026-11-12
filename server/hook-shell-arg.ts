// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { HookRepairFailed } from './drivers/scoped-cli-home.ts';

export type HookShellLayer = 'posix' | 'codex-runtime' | 'codex-scope' | 'cmd';
/** Encode one path for its actual command layer, before JSON/YAML serialization.
 * cmd callers use delayed expansion off; until verified, other cmd callers
 * refuse ! as well. Direct executable/argv calls must pass raw paths instead. */
export function shellArg(path: string, layer: HookShellLayer, engine = "Engine"): string {
  if (/[\0\r\n]/.test(path) || (layer !== 'posix' && /"/.test(path)) ||
    ((layer === 'codex-scope' || layer === 'cmd') && /%/.test(path)) || (layer === 'cmd' && /!/.test(path))) {
    throw new HookRepairFailed(engine, 'The hook path cannot be represented by its command shell.');
  }
  return layer === 'posix' ? "'" + path.replace(/'/g, "'\\''") + "'" : '"' + path + '"';
}
