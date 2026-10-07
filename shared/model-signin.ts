// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public, token-free shapes for plan sign-in (ChatGPT, Grok).
import type { SignInPreset } from "./provider-connections.ts";

export type SignInState = "signed-out" | "waiting" | "connected" | "needs-sign-in";
export type SignInError = "cancelled" | "timeout" | "unauthorized" | "offline" | "headless" | "disabled" | "storage" | "keyring" | "desktop-only" | "port" | "browser" | "unknown";

/** Main-process view, from window.muragebox.modelSignIn.status(). */
export interface SignInProviderStatus {
  provider: SignInPreset;
  /** The provider's flag. Off hides the button and stops routing. */
  enabled: boolean;
  state: SignInState;
  /** Grok's consent page sometimes shows a code to paste instead of redirecting. */
  acceptsCode: boolean;
  /** Set while a "sign in with a code" flow waits: show the code and the page to open. */
  device?: { userCode: string; verificationUrl: string };
  email?: string;
  plan?: string;
}

export type SignInResult = { ok: true; email?: string; plan?: string } | { ok: false; error: SignInError };

/** Server view, attached to the connection row in /api/provider-connections. */
export interface SignInConnectionInfo {
  provider: SignInPreset;
  state: "connected" | "needs-sign-in";
  unofficial: boolean;
  email?: string;
  plan?: string;
  /** Epoch ms. Set while a plan usage limit pauses work on this connection. */
  pausedUntil?: number;
}
