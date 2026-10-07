// SPDX-License-Identifier: AGPL-3.0-or-later
// Types for murage-env.mjs.
export declare function isAmbientMurageKey(key: string): boolean;
export declare function stripMurageEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function childEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv;
export declare function scrubAmbientMurageEnv(env?: NodeJS.ProcessEnv): Record<string, string | undefined>;
