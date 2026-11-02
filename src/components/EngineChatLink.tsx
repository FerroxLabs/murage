// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The button a chat link becomes (ENGINE-SIGNIN-SIMPLE-1014). A press shows a dialog or a Settings page and nothing else:
// only the press inside the dialog starts anything. The press hands the link to one host in App, because a reply's bubble
// is replaced when it stops streaming and a row can leave the transcript, and a dialog in there would close with it.
// What a press shows loads on that press (EngineChatLinkDialog.tsx): this file ships with every chat.
import { Suspense, useEffect, useState, type ReactNode } from "react";

import { parseEngineChatLink } from "@/lib/engine-chat-link";
import { currentLocalEngineLogin, engineSignInSurface } from "@/lib/engine-signin-surface";
import { t } from "@/lib/i18n";
import type { LocalEngineLoginBridge } from "@/lib/local-engine-login";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";

export const OPEN_ENGINE_CHAT_LINK_EVENT = "murage:engine-chat-link";

const Pressed = retryableLazy(() => import("./EngineChatLinkDialog").then((module) => ({ default: module.EngineChatLinkPress })));
const EngineChatLinkPress = Pressed.Component;

const button = "mx-0.5 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1 align-baseline text-[13px] font-semibold text-white hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

/** A button, never an href. A window that cannot run a sign-in (a phone, a browser, a Cloud home) gets the plain line. */
export function EngineChatLink({ href, children, bridge = currentLocalEngineLogin() }: {
  href: string;
  children?: ReactNode;
  /** Test seam; defaults to the desktop bridge. */
  bridge?: LocalEngineLoginBridge | null;
}) {
  const link = parseEngineChatLink(href);
  if (!link) return null;
  if (engineSignInSurface(bridge, typeof document === "undefined" ? undefined : document) !== "desktop") {
    return <span role="status" data-engine-chat-link-elsewhere className="text-ink-secondary">{t("engineSignIn.elsewhere")}</span>;
  }
  return <button type="button" data-engine-chat-link={link.kind} className={button} onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ENGINE_CHAT_LINK_EVENT, { detail: href }))}>
    {children}
    {link.kind === "plan" && link.provider === "supergrok" ? <span className="rounded bg-black/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">{t("modelSignIn.grok.unofficial")}</span> : null}
  </button>;
}

/** Mounted once in App. Takes the press and hands it to what loads on it. Each press is a new object, so the same link opens again. */
export function EngineChatLinkHost() {
  const [press, setPress] = useState<{ href: string } | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const href = (event as CustomEvent<unknown>).detail;
      if (typeof href === "string" && parseEngineChatLink(href)) setPress({ href });
    };
    window.addEventListener(OPEN_ENGINE_CHAT_LINK_EVENT, open);
    return () => window.removeEventListener(OPEN_ENGINE_CHAT_LINK_EVENT, open);
  }, []);
  if (!press) return null;
  return <LazyBoundary onRetry={Pressed.retry} onDismiss={() => setPress(null)}><Suspense fallback={null}><EngineChatLinkPress press={press} /></Suspense></LazyBoundary>;
}
