// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export const ENGINE_LOGIN_CHANNELS: Readonly<{ start: string; input: string; stop: string; openLink: string; data: string; closed: string }>;
export const ENGINE_LOGIN_ENGINES: readonly ["codex", "claudeAgent", "grokAgent", "kimiAgent", "opencodeGo"];
export const ENGINE_LOGIN_ACTIONS: readonly ["login", "logout", "enroll-key"];
export const ENGINE_KEY_ENGINES: readonly ["codex", "opencodeGo"];
export const ENGINE_LOGIN_SHAPES: Readonly<{ bot: RegExp; provider: RegExp; secret: RegExp }>;
export function engineLoginPath(request: { engine: string; action?: string; bot?: string; provider?: string; secret?: string }): string | null;
export const ENGINE_LOGIN_LIMITS: Readonly<{ idleMs: number; totalMs: number; keepaliveMs: number; maxInputBytes: number; maxInputTotal: number; maxLinkLength: number }>;
/** Exact-match vendor auth hosts; src/lib/engine-login-terminal.ts keeps the same list (a test compares them). */
export const ENGINE_LOGIN_AUTH_HOSTS: readonly string[];
export function checkAuthUrl(value: unknown, hosts?: readonly string[]): string | null;
export const COPY: Readonly<Record<string, string>>;
export class EngineLoginError extends Error { code: string }
export function refusalFor(status: number, bodyText?: string): EngineLoginError;
export function createEngineLoginRelay(deps: {
  client: { authorizeUpgrade(homeId: string, path: string): Promise<{ url: string; headers: Record<string, string> }> };
  createSocket: (url: string, options: object) => unknown;
  openExternal: (url: string) => unknown;
  timers?: unknown; limits?: Record<string, number>; log?: (line: string) => void;
}): {
  start(request: { sender: unknown; homeId: string; engine: string; action?: string; bot?: string; provider?: string; secret?: string }): Promise<{ ok: true; id: string } | { ok: false; code: string; message: string }>;
  input(request: { sender: unknown; id: string; data: string }): { ok: boolean; code?: string; message?: string };
  stop(request: { sender: unknown; id: string }): { ok: boolean; code?: string; message?: string };
  openLink(request: { sender: unknown; id: string; url: string }): Promise<{ ok: boolean; code?: string; message?: string }>;
  isOpen(): boolean;
};
export function registerEngineLoginIpc(deps: { ipcMain: { handle: (channel: string, listener: (event: any, ...args: any[]) => unknown) => void }; relay: unknown }): void;
