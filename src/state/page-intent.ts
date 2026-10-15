// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two client-side counters a bot-record request names itself by (BOTADDED-DESIGN-V3 r6 §2.6, §2.7). They hold no store state,
// so they live outside store.tsx: a component imports them, with `fromAnswer` from ./answer-tag, without loading the whole store.
import type { Action, AppState } from "./store";

/** A client nonce naming one Delete the person asked for: its retries carry it, and only its own answer settles it (§2.7). */
export function newDeleteAttempt(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const pageIntentCounter: Record<string, number> = {};
/** Every caller that asks the server for a page of a bot says so first (§2.6): the answer it gets carries this intent, and a page
 * asked for earlier never lands over it. Returns the intent to put on the answer's action. */
export function requestPage(dispatch: (action: Action) => void, state: Pick<AppState, "pageIntent">, botId: string): number {
  const intent = Math.max(pageIntentCounter[botId] ?? 0, state.pageIntent?.[botId] ?? 0) + 1;
  pageIntentCounter[botId] = intent;
  dispatch({ type: "pageRequested", botId, intent });
  return intent;
}
