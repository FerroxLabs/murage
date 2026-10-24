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

export const APP_VERSION: string = packageVersion;

export type WhatsNewEntry = { kind: "page"; releaseNotesUrl: string } | { kind: "none" };

export const WHATS_NEW_BY_VERSION: Readonly<Record<string, WhatsNewEntry>> = {
  "0.1.59": { kind: "page", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v0.1.59" },
  "0.1.60": { kind: "page", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v0.1.60" },
  "0.1.61": { kind: "page", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v0.1.61" },
  // A patch: no page (release notes are written at publish).
  "0.1.62": { kind: "none" },
  // 1.0.0: the full notes are on the release page; the in-app page returns
  // with art made for 1.0.
  "1.0.0": { kind: "none" },
  // A patch: no page (release notes are written at publish).
  "1.0.1": { kind: "none" },
  // 1.0.2: the page, with art made for it (whats-new-art-0102).
  "1.0.2": { kind: "page", releaseNotesUrl: "https://github.com/FerroxLabs/murage-releases/releases/tag/v1.0.2" },
  // 1.0.3: the notes and known limits are on the docs changelog and the release page; the in-app page returns with art made for it.
  "1.0.3": { kind: "none" },
  // 1.0.4: the 1.0.3 hotfix; its notes are on the docs changelog and the release page.
  "1.0.4": { kind: "none" },
  // 1.0.5: the 1.0.4 hotfix; its notes are on the docs changelog and the release page.
  "1.0.5": { kind: "none" },
};

/** The page for `version`, or null when it has none. */
export function whatsNewPage(version: string = APP_VERSION): Extract<WhatsNewEntry, { kind: "page" }> | null {
  const entry = WHATS_NEW_BY_VERSION[version];
  return entry?.kind === "page" ? entry : null;
}

function parts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const left = parts(a), right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The release notes for `version` on the docs changelog, which exists for every release. */
export function changelogUrl(version: string = APP_VERSION): string {
  return `https://docs.murage.ai/docs/changelog/v${version.replace(/\./g, "-")}`;
}

export type WhatsNewTarget =
  | { kind: "page"; version: string; releaseNotesUrl: string }
  | { kind: "notes"; url: string };

/** What the What's new menu item opens for `version`: its own page, else the
 *  newest page on the same major line that is not newer than it, else the
 *  release notes for the version on the docs changelog. */
export function whatsNewTarget(version: string = APP_VERSION): WhatsNewTarget {
  const own = whatsNewPage(version);
  if (own) return { kind: "page", version, releaseNotesUrl: own.releaseNotesUrl };
  const major = parts(version)[0];
  const newest = Object.entries(WHATS_NEW_BY_VERSION)
    .filter(([candidate, entry]) => entry.kind === "page" && parts(candidate)[0] === major && compareVersions(candidate, version) <= 0)
    .sort(([a], [b]) => compareVersions(b, a))[0];
  if (newest && newest[1].kind === "page") return { kind: "page", version: newest[0], releaseNotesUrl: newest[1].releaseNotesUrl };
  return { kind: "notes", url: changelogUrl(version) };
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

/** Opens by itself once when the server says so; `reopen` is the You menu and
 *  Settings: it opens the page, or the release notes when there is no page, so
 *  the item is always there on the desktop; `close` always records the version
 *  as seen. */
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
  const reopen = useCallback(() => {
    const target = whatsNewTarget();
    if (target.kind === "page") { setOpen(true); return; }
    void import("./open-external").then((module) => module.openExternalPage(target.url, "Murage could not open the release notes.")).catch(() => {});
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    void recordWhatsNewSeen(desktop, request);
  }, [desktop, request]);
  return { open, reopen, close, available: desktop === true };
}
