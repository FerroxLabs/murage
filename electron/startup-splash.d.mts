// SPDX-License-Identifier: AGPL-3.0-or-later
export function splashPage(options?: { dark?: boolean; pct?: number; line?: string; note?: string; language?: string; mode?: "tip" | "update" | "first"; picture?: unknown; version?: string; platform?: string }): string;
export function showBootStep<T extends { bootStep(step: string): boolean } | null>(splash: T, step: string | undefined, create: () => T): T;
export function createStartupSplash(options?: Record<string, unknown>): { bootStep(step: string | undefined): boolean; stage(name: string): boolean; set(view: unknown): boolean; [key: string]: unknown };
