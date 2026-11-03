// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The bridge window.muragebox.localEngineLogin. src/lib/local-engine-login.ts holds the renderer's copy; a test pins the channel list.
export interface LocalEngineLoginChannels { preview: string; start: string; stop: string; openTerminal: string; data: string; closed: string }
export const LOCAL_ENGINE_LOGIN_CHANNELS: Readonly<LocalEngineLoginChannels>;
export const LOCAL_ENGINE_LOGIN_LIMITS: Readonly<Record<string, number>>;
export const LOCAL_COPY: Readonly<Record<string, string>>;

export type LocalEngineLoginKind = "headless" | "terminal" | "none";
export type LocalEngineLoginResult = "signed-in" | "not-finished" | "stopped" | "failed";
export type LocalEngineLoginRefusal = { ok: false; code: string; message: string };
export type LocalEngineLoginPreview = { ok: true; kind: LocalEngineLoginKind; label: string; accountRoot: string } | LocalEngineLoginRefusal;
export type LocalEngineLoginStart = { ok: true; id: string } | LocalEngineLoginRefusal;
export type LocalEngineLoginAck = { ok: true } | LocalEngineLoginRefusal;

/** Progress only: the probe saw this engine sign in. Nothing the CLI printed ever comes this way. */
export interface LocalEngineLoginData { id: string; finishing?: boolean }
export interface LocalEngineLoginClosed { id: string; result: LocalEngineLoginResult; message?: string }

export interface LocalEngineLoginBridge {
  preview(request: { instanceId: string }): Promise<LocalEngineLoginPreview>;
  start(request: { instanceId: string }): Promise<LocalEngineLoginStart>;
  stop(request: { id: string }): Promise<LocalEngineLoginAck>;
  openTerminal(request: { instanceId: string }): Promise<LocalEngineLoginStart>;
  onData(listener: (data: LocalEngineLoginData) => void): () => void;
  onClosed(listener: (closed: LocalEngineLoginClosed) => void): () => void;
}

export interface LocalEngineLoginRunner {
  preview(request: { instanceId: string }): Promise<LocalEngineLoginPreview>;
  start(request: { sender: unknown; instanceId: string }): Promise<LocalEngineLoginStart>;
  stop(request: { sender: unknown; id: string }): Promise<LocalEngineLoginAck>;
  openTerminal(request: { sender: unknown; instanceId: string }): Promise<LocalEngineLoginStart>;
  openRecipeTerminal(request: { instanceId: string }): Promise<boolean>;
  shutdown(): Promise<void>;
  isOpen(): boolean;
}
export function createLocalEngineLogin(deps: {
  api: (path: string, body?: unknown, options?: { timeoutMs?: number }) => Promise<{ status: number; body: any }>;
  spawn: (...args: any[]) => any;
  killTree: (child: any, signal: string) => void;
  launchTerminal?: (recipe: any) => Promise<{ ok: boolean; supervisor?: { alive(): boolean; stop(): Promise<void> }; code?: string }>;
  timers?: any;
  log?: (line: string) => void;
  limits?: Record<string, number>;
  newId?: () => string;
}): LocalEngineLoginRunner;
export function registerLocalEngineLoginIpc(deps: { ipcMain: { handle: (channel: string, listener: (event: any, ...args: any[]) => unknown) => void }; runner: unknown }): void;
