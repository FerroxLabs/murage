// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The desktop shell's half of the MCP servers panel: secrets, browser sign-in
// and removal all run in Electron main (spec MCP-LINK 3.4, 3.7). The surface is
// published in lanes/mcplink/API-T11.md and lands in src/types/muragebox.d.ts
// with the main-process wiring. The types are restated here so the panel does
// not wait for that file, and so this is the one place to change if it moves.
//
// In a plain browser, the browser door or a dev run there is no bridge
// (`mcpBridge()` returns undefined): values then travel in the request body, as
// the harness accepts only when it has no desktop shell, and sign-in is
// unavailable.

/** A secret typed by the owner. Nothing ever returns a value. */
export interface McpSecretsInput {
  headers?: Record<string, string>;
  url?: string;
  env?: Record<string, string>;
}

export type McpBridgeError =
  | "desktop-only" | "storage" | "not-found" | "invalid" | "stale" | "busy" | "headless"
  | "not-sign-in" | "no-registration" | "refused" | "cancelled" | "denied" | "timeout"
  | "port" | "browser" | "network" | "token" | "unknown";

export type McpBridgeResult = { ok: true } | { ok: false; error: McpBridgeError; message: string };
export type McpSignOutResult = { ok: true; revoked: boolean; message: string } | { ok: false; error: McpBridgeError; message: string };
export type McpRemoveResult = { ok: true; revoked: boolean | null; message: string } | { ok: false; error: McpBridgeError; message: string };

export interface McpBridge {
  /** "local-config" (a dev Electron launch): every other call answers `desktop-only`, so values go in the body. */
  mode(): Promise<"desktop" | "local-config">;
  saveSecrets(name: string, input: McpSecretsInput): Promise<McpBridgeResult>;
  signIn(name: string): Promise<McpBridgeResult>;
  cancelSignIn(name: string): Promise<boolean>;
  signOut(name: string): Promise<McpSignOutResult>;
  remove(name: string): Promise<McpRemoveResult>;
}

/** The desktop bridge, or undefined when this is not the desktop app. */
export function mcpBridge(): McpBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { muragebox?: { mcpServers?: McpBridge } }).muragebox?.mcpServers;
}

/** The bridge when it can really hold secrets and sign in (packaged desktop),
 * else undefined: values then travel in the body, which the harness accepts
 * only when it has no desktop shell. */
export async function usableMcpBridge(): Promise<McpBridge | undefined> {
  const bridge = mcpBridge();
  if (!bridge) return undefined;
  try {
    return (await bridge.mode()) === "desktop" ? bridge : undefined;
  } catch {
    return undefined;
  }
}
