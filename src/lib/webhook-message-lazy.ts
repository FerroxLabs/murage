// The webhook bubble's parser (webhook-message.ts) loads on first use, not on
// first paint: most chats never hold a webhook run, and the event-fence parsing
// pushed the first paint over its budget (scripts/check-bundle-budget.mjs).
//
// What stays on first paint is one cheap test that every webhook prompt passes.
// A message that passes it is held until the parser is here: the bubble shows
// WEBHOOK_LOADING_TEXT, never the stored text, because that text is the
// model-facing prompt with the sender's event data in it. If the parser cannot
// load, the bubble keeps holding it and offers the app's usual retry
// (LazyBoundary's LAZY_RETRY_TEXT, which reloads the page).
import { useEffect, useState } from "react";

import type { WebhookMessageView } from "./webhook-message";

type WebhookMessageModule = typeof import("./webhook-message");

export const WEBHOOK_LOADING_TEXT = "Loading message…";

/** The two openers webhookMessageView can read a webhook run from: the server's
 *  event fence line (webhooks.ts eventPrompt) and the stored pre-1.0.15 bracket.
 *  Every text the parser turns into a view contains one of them, so a text with
 *  neither is an ordinary message and never waits for the parser. */
const WEBHOOK_OPENERS = [" origin=webhook kind=webhook-event>>", "[UNTRUSTED WEBHOOK EVENT DATA]"];

export function looksLikeWebhookMessage(text: string): boolean {
  return WEBHOOK_OPENERS.some((opener) => text.includes(opener));
}

export type WebhookViewState =
  | { status: "none" }
  | { status: "view"; view: WebhookMessageView }
  | { status: "loading" }
  | { status: "failed" };

let loader: () => Promise<WebhookMessageModule> = () => import("./webhook-message");
let loaded: WebhookMessageModule | null = null;
let loading: Promise<WebhookMessageModule> | null = null;
let failed = false;

/** One import for every bubble. A failure is remembered, so held bubbles show
 *  the retry instead of waiting forever; the retry reloads the page, which is
 *  the only way past a browser that caches a failed import (LazyBoundary.tsx). */
export function loadWebhookMessage(): Promise<WebhookMessageModule> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= loader().then(
    (module) => {
      loaded = module;
      failed = false;
      return module;
    },
    (error: unknown) => {
      failed = true;
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** What the bubble shows for this text right now. Synchronous, so a parser that
 *  is already here draws the webhook card on the first render. */
export function webhookViewNow(text: string): WebhookViewState {
  if (!looksLikeWebhookMessage(text)) return { status: "none" };
  if (loaded) {
    const view = loaded.webhookMessageView(text);
    return view ? { status: "view", view } : { status: "none" };
  }
  return failed ? { status: "failed" } : { status: "loading" };
}

/** The bubble's webhook view; an empty text (a bot message) is never one. */
export function useWebhookMessageView(text: string): WebhookViewState {
  const state = webhookViewNow(text);
  const [, settled] = useState(0);
  const waiting = state.status === "loading";
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const redraw = () => {
      if (live) settled((count) => count + 1);
    };
    loadWebhookMessage().then(redraw, redraw);
    return () => {
      live = false;
    };
  }, [waiting]);
  return state;
}

/** The words a quote of this message shows (the pinned banner, a reply): a
 *  webhook run's task, the placeholder while it is held, any other text as it
 *  is. Only a user message can be a webhook run. */
export function useWebhookDisplayText(text: string, user: boolean): string {
  const state = useWebhookMessageView(user ? text : "");
  if (state.status === "view") return state.view.task;
  if (state.status === "loading" || state.status === "failed") return WEBHOOK_LOADING_TEXT;
  return text;
}

/** Test seam: swap the import and forget what was loaded. */
export function resetWebhookMessageLoaderForTest(next?: () => Promise<WebhookMessageModule>): void {
  loader = next ?? (() => import("./webhook-message"));
  loaded = null;
  loading = null;
  failed = false;
}
