// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The first run, on a Cloud home. Every decision of "is this Cloud" is `isCloudHome()` (src/lib/cloud-workspace.ts), asked by
// the caller and passed in here, so each function below is pure and a test can run it both ways. Off a home none of this is
// reached and the desktop first run is unchanged. The words live in src/locales/en-ux/cloud.json, read through uxCloud().
import { homeMeta } from "./cloud-home-meta";
import { uxCloud } from "./cloud-ux-copy";
import { isCloudOrigin } from "./cloud-workspace";
import type { FirstRunCloudRows, FirstRunJobId } from "./first-run-jobs";

/** One job row in everyday words: what a retired bookkeeper would ask for, with no jargon. */
export function cloudJobCopy(id: FirstRunJobId): { title: string; sub: string } {
  return { title: uxCloud(`ux.cloud.firstRun.job.${id}.title`), sub: uxCloud(`ux.cloud.firstRun.job.${id}.sub`) };
}

/** Every job's Cloud row, for `firstRunJobWorld`. */
export function cloudJobRows(): FirstRunCloudRows {
  return { brief: cloudJobCopy("brief"), day: cloudJobCopy("day"), notes: cloudJobCopy("notes"), research: cloudJobCopy("research"), business: cloudJobCopy("business") };
}

/**
 * The bookmark line. Only in a browser on a home: the Cloud window is an app and has no page to bookmark. It names the door
 * (`<site>/home/cloud`) only when the home told the page its site origin (a bare https origin, see withCloudHomeId in
 * server/index.ts); otherwise it says the bookmark part alone rather than invent an address.
 */
export function cloudBookmarkLine(doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined" ? undefined : document): string | null {
  if (!doc || isCloudOrigin()) return null;
  const meta = homeMeta(doc);
  if (!meta.homeId) return null;
  let host: string | null = null;
  try { host = meta.siteOrigin ? new URL(meta.siteOrigin).host : null; } catch { host = null; }
  return host ? uxCloud("ux.cloud.firstRun.bookmarkDoor").replace("{site}", host) : uxCloud("ux.cloud.firstRun.bookmark");
}
