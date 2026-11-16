// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from 'node:url';

/** A server whose engines are fixture CLIs needs the same native-execution
 * stand-ins as the Vitest worker. Approval policy remains real in the child. */
export function fakeEngineServerArgs(...args: string[]): string[] {
  return ['--import', fileURLToPath(new URL('./fake-engine-server-preload.mjs', import.meta.url)), ...args];
}
