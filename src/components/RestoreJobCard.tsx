// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Backups: where a restore stands. The server sends a stable code and names the OK action; this card maps the code to its own locale text
// and shows nothing when there is no restore to talk about. Only a desktop surface may press OK (on a Cloud home the owner's phone and acting owner
// browser count as desktop; a local install's paired phone does not). It reads on mount, when the connection comes back, and when Backups asks to be
// checked again. It never polls.
import { useCallback, useEffect, useRef, useState } from "react";
import { api as apiCall, useStoreSelector } from "@/state/store";
import { isDesktopSurface } from "@/lib/surface";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export interface RestoreJobAction { label: string; method: string; path: string }
export interface RestoreJobStatus { state: string; code: string | null; line: string | null; action: RestoreJobAction | null }
type Api = (path: string, init?: RequestInit) => Promise<any>;

const ACTION_PREFIX = "/api/restore-job/";
const STATE_CODES: Record<string, string> = { running: "finishing", unreadable: "stuck_or_unreadable", aborted: "aborted" };
const IN_PROGRESS: LocaleKey = "restoreJob.inProgress";
/** Every code the restore routes send, mapped to its locale text. The aborted code has a variant for a surface that cannot press OK. */
const TEXT_KEYS: Record<string, { press: LocaleKey; readOnly?: LocaleKey }> = {
  finishing: { press: IN_PROGRESS },
  restore_finishing: { press: IN_PROGRESS },
  stuck_or_unreadable: { press: IN_PROGRESS },
  aborted: { press: "restoreJob.abortedDesktop", readOnly: "restoreJob.abortedPhone" },
  restore_aborted: { press: "restoreJob.abortedDesktop", readOnly: "restoreJob.abortedPhone" },
  restore_failed: { press: "restoreJob.failed" },
  backup_running: { press: "restoreJob.backupRunning" },
  owner_only: { press: "restoreJob.ownerOnly" },
};
/** The locale text for a server code, or null for a code this app does not know (the card then shows nothing). */
export function restoreJobText(code: string | null | undefined, canDismiss: boolean): string | null {
  const keys = code ? TEXT_KEYS[code] : undefined;
  return keys ? t(canDismiss ? keys.press : keys.readOnly ?? keys.press) : null;
}

/** A restore action is only ever a POST under /api/restore-job/ (it carries the desktop secret header, so nothing else may be named). */
const cleanAction = (value: any): RestoreJobAction | null => {
  if (!value || typeof value !== "object" || typeof value.path !== "string" || !value.path.startsWith(ACTION_PREFIX) || value.path.includes("..") || value.path.includes("//")) return null;
  const method = value.method === undefined ? "POST" : value.method;
  return method === "POST" ? { label: typeof value.label === "string" ? value.label : "OK", method, path: value.path } : null;
};
const clean = (value: any): RestoreJobStatus | null => {
  if (!value || typeof value !== "object" || typeof value.state !== "string") return null;
  const code = typeof value.code === "string" && value.code in TEXT_KEYS ? value.code : value.code === undefined || value.code === null ? STATE_CODES[value.state] ?? null : null;
  return { state: value.state, code, line: typeof value.line === "string" ? value.line : null, action: cleanAction(value.action) };
};

export async function readRestoreJob(api: Api): Promise<RestoreJobStatus | null> {
  try { return clean(await api("/api/restore-job/status")); } catch { return null; }
}
/** Presses the action the server named; the answer is the new status. A refusal re-reads it. */
export async function dismissRestoreJob(api: Api, action: RestoreJobAction): Promise<RestoreJobStatus | null> {
  try { return clean(await api(action.path, { method: action.method })); } catch { return readRestoreJob(api); }
}

export function RestoreJobCardView({ status, canDismiss, busy, onDismiss }: { status: RestoreJobStatus | null; canDismiss: boolean; busy?: boolean; onDismiss: () => void }) {
  const text = status && status.state !== "none" ? restoreJobText(status.code, canDismiss) : null;
  if (!status || !text) return null;
  const action = canDismiss ? status.action : null;
  return <section data-restore-job role="status" className="min-w-0 space-y-3 rounded-xl border border-hairline/40 bg-card p-4">
    <p className="text-[13px] text-ink">{text}</p>
    {action && <button type="button" disabled={busy} onClick={onDismiss} className="min-h-11 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50">{t("browserExt.l3.dialog.ok")}</button>}
  </section>;
}

const selectConnected = (state: { connected: boolean }) => state.connected;

/** `refreshKey` changes when the screen's Check again runs; `connected` rising from false to true re-reads once. */
export function RestoreJobCard({ refreshKey = 0 }: { refreshKey?: number }) {
  const connected = useStoreSelector(selectConnected);
  const [status, setStatus] = useState<RestoreJobStatus | null>(null), [desktop, setDesktop] = useState(false), [busy, setBusy] = useState(false), [edge, setEdge] = useState(0);
  const was = useRef(connected);
  useEffect(() => { if (!was.current && connected) setEdge(n => n + 1); was.current = connected; }, [connected]);
  useEffect(() => { let alive = true; void readRestoreJob(apiCall).then(s => { if (alive) setStatus(s); }); return () => { alive = false; }; }, [refreshKey, edge]);
  // A rejected surface check keeps the status read-only, with the owner instructions and no dismiss action.
  useEffect(() => { let alive = true; void isDesktopSurface().then(d => { if (alive) setDesktop(d); }).catch(() => { if (alive) setDesktop(false); }); return () => { alive = false; }; }, []);
  const dismiss = useCallback(async () => { if (!status?.action) return; setBusy(true); const next = await dismissRestoreJob(apiCall, status.action); setStatus(next); setBusy(false); }, [status]);
  return <RestoreJobCardView status={status} canDismiss={desktop} busy={busy} onDismiss={() => void dismiss()} />;
}
