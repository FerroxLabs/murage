// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from upstream (Apache-2.0): preload browser tools for Claude turns.
import type { SendTurnInput } from "../contracts.ts";

export function claudeBrowserMount(turn: Pick<SendTurnInput, "integrations" | "preloadBrowserTools" | "prewarm">) {
  const browser = turn.integrations?.browser;
  if (!browser) return undefined;
  // Other engines have no tool-search deferral.
  return { ...browser, ...(turn.preloadBrowserTools === true && !turn.prewarm ? { alwaysLoad: true as const } : {}) };
}
