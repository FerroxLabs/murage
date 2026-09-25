// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Announcements in the renderer: ask the harness which notices this install
// should see (server/announcements.ts fetches, verifies and filters), show
// the first one, and tell the harness when it is dismissed. The renderer
// never fetches the feed or an image from the internet itself.
import { useCallback, useEffect, useRef, useState } from "react";
import { APP_VERSION } from "@/lib/whats-new";
import type { Announcement, AnnouncementActionTarget } from "../../shared/announcements";

export {
  ANNOUNCEMENT_ACTIONS,
  ANNOUNCEMENT_LAYOUTS,
  ANNOUNCEMENT_ACCENTS,
  announcementSurface,
  parseAnnouncementBody,
  type AnnouncementInline,
  type AnnouncementActionTarget,
  type AnnouncementLayout,
  type AnnouncementAccent,
  type AnnouncementKind,
} from "../../shared/announcements";

/** One notice as the harness hands it over: `image` is a local route. */
export type AnnouncementView = Omit<Announcement, "appVersions" | "platforms" | "startsAt" | "endsAt">;

/** Fired after the Settings switch changes, so the host asks again. */
export const ANNOUNCEMENTS_CHANGED_EVENT = "murage:announcements-changed";

type Request = (path: string, init?: RequestInit) => Promise<unknown>;

const ASK_EVERY_MS = 30 * 60 * 1000;

function views(answer: unknown): AnnouncementView[] {
  if (!answer || typeof answer !== "object") return [];
  const items = (answer as { items?: unknown }).items;
  return Array.isArray(items) ? (items as AnnouncementView[]).filter((item) => item && typeof item.id === "string" && typeof item.title === "string") : [];
}

/** The notices to show, first one first. Desktop only; any failure answers
 *  with nothing, since a notice is never worth an error. */
export function useAnnouncements(desktop: boolean | undefined, request: Request, version: string = APP_VERSION) {
  const [items, setItems] = useState<AnnouncementView[]>([]);
  const generation = useRef(0);
  const ask = useCallback(async () => {
    if (desktop !== true) return;
    const mine = ++generation.current;
    try {
      const answer = await request(`/api/announcements?version=${encodeURIComponent(version)}`);
      if (mine === generation.current) setItems(views(answer));
    } catch {
      // keep what is on screen
    }
  }, [desktop, request, version]);

  useEffect(() => {
    if (desktop !== true) return;
    void ask();
    const again = () => void ask();
    const timer = window.setInterval(again, ASK_EVERY_MS);
    window.addEventListener(ANNOUNCEMENTS_CHANGED_EVENT, again);
    window.addEventListener("focus", again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(ANNOUNCEMENTS_CHANGED_EVENT, again);
      window.removeEventListener("focus", again);
    };
  }, [desktop, ask]);

  const dismiss = useCallback((id: string) => {
    // Gone from the screen at once; the harness remembers it for good.
    generation.current++;
    setItems((current) => current.filter((item) => item.id !== id));
    void request("/api/announcements/dismiss", { method: "POST", body: JSON.stringify({ id }) }).catch(() => {});
  }, [request]);

  return { current: items[0] ?? null, queued: Math.max(0, items.length - 1), dismiss };
}

/** Load a cached notice image as an object URL. The route is desktop-gated,
 *  so it is fetched with the caller's headers instead of an <img src>. */
export function useAnnouncementImage(path: string | undefined, load: (path: string) => Promise<Blob>): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ path?: string; url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    if (!path) { setState({ url: null, failed: false }); return; }
    let live = true;
    let made: string | null = null;
    setState({ path, url: null, failed: false });
    load(path).then((blob) => {
      if (!live) return;
      made = URL.createObjectURL(blob);
      setState({ path, url: made, failed: false });
    }).catch(() => { if (live) setState({ path, url: null, failed: true }); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path, load]);
  return state.path === path ? { url: state.url, failed: state.failed } : { url: null, failed: false };
}

/** Where each in-app action goes, as settings sections and one updater call. */
export const ANNOUNCEMENT_ACTION_SECTIONS: Readonly<Record<Exclude<AnnouncementActionTarget, "check-for-updates">, "general" | "models" | "connections" | "skills" | "houseRules" | "backups">> = {
  "settings-general": "general",
  "settings-models": "models",
  "settings-connections": "connections",
  "settings-skills": "skills",
  "settings-house-rules": "houseRules",
  "settings-backups": "backups",
};

/** A link in a notice opens in the system browser, never in the app. */
export async function openAnnouncementLink(url: string): Promise<void> {
  if (!/^https:\/\//.test(url)) return;
  if (window.muragebox?.openExternal) {
    await window.muragebox.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
