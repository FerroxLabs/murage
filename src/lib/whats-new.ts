// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What's new: which versions have a page, and when this install sees it.
//
// Every released version either has a page here or says "none" out loud, and
// whats-new.test.ts fails the build when package.json's version has neither,
// so a release cannot ship having simply forgotten.
//
// The server remembers what this install has seen (server/whats-new.ts, in
// the data dir). The renderer only asks, on the desktop, for a version that
// has a page, and tells it when the page closes, however it closed.
import { useCallback, useEffect, useRef, useState } from "react";
import { version as packageVersion } from "../../package.json";
import { botRole, type RoleBot } from "@/lib/bot-role";

export const APP_VERSION: string = packageVersion;

export type WhatsNewEntry = { kind: "page"; releaseNotesUrl: string } | { kind: "none" };

export const WHATS_NEW_BY_VERSION: Readonly<Record<string, WhatsNewEntry>> = {
  "0.1.59": { kind: "page", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v0.1.59" },
};

/** The page for `version`, or null when it has none. */
export function whatsNewPage(version: string = APP_VERSION): Extract<WhatsNewEntry, { kind: "page" }> | null {
  const entry = WHATS_NEW_BY_VERSION[version];
  return entry?.kind === "page" ? entry : null;
}

type Request = (path: string, init?: RequestInit) => Promise<unknown>;

/** Should the page open by itself now? Only on the desktop, only for a
 *  version with a page, and only when the server says this install has not
 *  seen it. Any failure answers no: this screen is never worth an error. */
export async function shouldOpenWhatsNew(desktop: boolean | undefined, request: Request, version: string = APP_VERSION): Promise<boolean> {
  if (desktop !== true || !whatsNewPage(version)) return false;
  try {
    const answer = await request(`/api/whats-new?version=${encodeURIComponent(version)}`);
    return Boolean(answer && typeof answer === "object" && (answer as { show?: unknown }).show === true);
  } catch {
    return false;
  }
}

/** Remember that the page closed. Best effort: failing leaves it to show once more. */
export async function recordWhatsNewSeen(desktop: boolean | undefined, request: Request, version: string = APP_VERSION): Promise<void> {
  if (desktop !== true || !whatsNewPage(version)) return;
  try {
    await request("/api/whats-new/seen", { method: "POST", body: JSON.stringify({ version }) });
  } catch {
    // nothing to tell the person; the page simply shows again next launch
  }
}

/** The bot the page's shortcuts act on: the chat that is open, else the
 *  Chief of Staff, else the first bot on the list. */
export function whatsNewTargetBot<T extends RoleBot & { id: string; hidden?: boolean }>(bots: readonly T[], selectedId: string | null | undefined): T | null {
  const visible = bots.filter((bot) => !bot.hidden);
  return visible.find((bot) => bot.id === selectedId) ?? visible.find((bot) => botRole(bot) === "chief") ?? visible[0] ?? null;
}

/** Opens by itself once when the server says so; `reopen` is the Tools menu;
 *  `close` always records the version as seen. */
export function useWhatsNew(desktop: boolean | undefined, request: Request) {
  const [open, setOpen] = useState(false);
  const asked = useRef(false);
  useEffect(() => {
    if (desktop !== true || asked.current) return;
    // Asked once per page load. No cancel on cleanup: StrictMode's probe
    // unmount would otherwise swallow the only answer.
    asked.current = true;
    void shouldOpenWhatsNew(desktop, request).then((show) => { if (show) setOpen(true); });
  }, [desktop, request]);
  const reopen = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    setOpen(false);
    void recordWhatsNewSeen(desktop, request);
  }, [desktop, request]);
  return { open, reopen, close, available: desktop === true && whatsNewPage() !== null };
}
