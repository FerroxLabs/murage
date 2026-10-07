// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// What a publish approval card carries (card.kind === "publish"). The server
// builds it from the real file listing and updates its `progress` as the site
// goes up; the card UI (src/components/PublishCard.tsx) renders it.

/** Where a publish or take-down stands. The card is the progress display, so
 * the owner watches one thing change instead of a stack of status lines. */
export type PublishStep = "uploading" | "checking" | "live" | "taken-down" | "failed";
/** Why it failed, as a code the UI turns into one plain sentence and a next step. */
export type PublishFailure = "reconnect" | "wait" | "too-big" | "name-taken" | "not-live" | "other";
export interface PublishProgress { step: PublishStep; fileCount?: number; failure?: PublishFailure }

/** The "Connect Netlify" card: shown when a bot needs Netlify and none is connected. */
export interface PublishConnect { state: "needed" | "connected"; /** The bot that asked, so the paused task resumes in a group chat too. */ botId?: string }

export interface PublishCardData {
  action: "publish" | "update" | "take-down" | "connect";
  host: "netlify";
  /** The address the site is (or was) served at. */
  url: string;
  siteName?: string;
  siteId?: string;
  deployId?: string;
  /** Exactly the files that will go up, with sizes in bytes. */
  files?: { path: string; size: number }[];
  totalBytes?: number;
  /** Names left out because they are private (dotfiles, keys, memory). */
  skipped?: string[];
  progress?: PublishProgress;
  /** Present on action "connect" only. */
  connect?: PublishConnect;
}

const ACTIONS = ["publish", "update", "take-down", "connect"];
const STEPS: string[] = ["uploading", "checking", "live", "taken-down", "failed"];
const FAILURES: string[] = ["reconnect", "wait", "too-big", "name-taken", "not-live", "other"];
const isCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;

/** Map a server error code to the failure the card words for the owner. */
export function publishFailureOf(code: string): PublishFailure {
  switch (code) {
    case "reconnect": return "reconnect";
    case "rate-limited": case "host-down": return "wait";
    case "too-large": case "too-many-files": return "too-big";
    case "name-taken": return "name-taken";
    case "not-live": return "not-live";
    default: return "other";
  }
}

/** The card's publish data when it is well formed, else null. Anything else is
 * not rendered as a publish card (and never offers a button). */
export function readPublishCard(card: unknown): PublishCardData | null {
  if (!card || typeof card !== "object") return null;
  const value = card as { kind?: unknown; publish?: unknown };
  if (value.kind !== "publish" || !value.publish || typeof value.publish !== "object") return null;
  const data = value.publish as Partial<PublishCardData>;
  if (typeof data.action !== "string" || !ACTIONS.includes(data.action) || data.host !== "netlify") return null;
  if (!text(data.url, 2048) || !/^https:\/\//.test(data.url as string)) return null;
  if (data.siteName !== undefined && !text(data.siteName, 128)) return null;
  if (data.siteId !== undefined && !text(data.siteId, 64)) return null;
  if (data.deployId !== undefined && !text(data.deployId, 64)) return null;
  if (data.totalBytes !== undefined && !isCount(data.totalBytes)) return null;
  if (data.files !== undefined && (!Array.isArray(data.files) || data.files.length > 30_000
    || data.files.some(file => !file || !text(file.path, 1024) || !isCount(file.size)))) return null;
  if (data.skipped !== undefined && (!Array.isArray(data.skipped) || data.skipped.some(name => !text(name, 1024)))) return null;
  if (data.action === "connect") {
    if (!data.connect || typeof data.connect !== "object" || (data.connect.state !== "needed" && data.connect.state !== "connected") || (data.connect.botId !== undefined && !text(data.connect.botId, 128))) return null;
  } else if (data.connect !== undefined) return null;
  const progress = data.progress;
  if (progress !== undefined) {
    if (!progress || typeof progress !== "object" || !STEPS.includes(progress.step)) return null;
    if (progress.fileCount !== undefined && !isCount(progress.fileCount)) return null;
    if (progress.failure !== undefined && !FAILURES.includes(progress.failure)) return null;
  }
  return data as PublishCardData;
}
