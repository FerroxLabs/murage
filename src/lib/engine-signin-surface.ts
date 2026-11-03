// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which sign-in a window can offer. The buttons read this with the first paint; the session behind them
// (local-engine-login.ts) loads with the dialog.
import { homeMeta } from "@/lib/cloud-home-meta";
import type { LocalEngineLoginBridge } from "@/lib/local-engine-login";

/** desktop: this window can run a sign-in. cloud-home: the Cloud's own screens own it. elsewhere: a browser or a phone. */
export type EngineSignInSurface = "desktop" | "cloud-home" | "elsewhere";

export function engineSignInSurface(bridge: LocalEngineLoginBridge | null | undefined, doc: Pick<Document, "querySelector"> | undefined): EngineSignInSurface {
  if (doc && homeMeta(doc).homeId) return "cloud-home";
  return bridge ? "desktop" : "elsewhere";
}

export function currentLocalEngineLogin(): LocalEngineLoginBridge | null {
  return typeof window === "undefined" ? null : (window.muragebox?.localEngineLogin ?? null);
}
