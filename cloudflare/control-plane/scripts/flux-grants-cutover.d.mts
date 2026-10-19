// SPDX-License-Identifier: AGPL-3.0-or-later
// Types for scripts/flux-grants-cutover.mjs (the tests import the real CLI adapter and main).
type Exec = (cmd: string, args: string[], opts: unknown) => string | Promise<string>;
export declare function d1Adapter(database: string, wranglerEnv: string | undefined, exec: Exec): D1Database;
export declare function main(argv: string[], deps?: { exec?: Exec; env?: Record<string, string | undefined>; now?: number;
  log?: (s: string) => void; error?: (s: string) => void }): Promise<number>;
