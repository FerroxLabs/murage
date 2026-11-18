// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useRef, useState } from "react";
import { Brain, Info } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";
import { useSettingsMode } from "@/lib/settings-mode";
import { openSettingsAddress } from "@/lib/open-settings-address";
import { onSignedOut, sessionSignedOut } from "@/lib/session-check";
import { useFocusTrap } from "@/lib/focus-trap";
import { t } from "@/lib/i18n";
import { LayerSurface } from "./LayerSurface";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";

import { freshStartPreviewSchema, freshStartOutcomeSchema, freshStartConfirmRequestSchema,
  type FreshStartPreview, type FreshStartOutcome, type FreshStartConfirmRequest as ConfirmRequest,
  GH18_BLOCKED_REASONS } from "../../shared/gh18-fresh-start-contract";
export type { FreshStartPreview, FreshStartOutcome } from "../../shared/gh18-fresh-start-contract";
type BlockedReason = typeof GH18_BLOCKED_REASONS[number];
function readWire(raw: unknown, botId: string, preview: true): FreshStartPreview;
function readWire(raw: unknown, botId: string, preview: false): FreshStartOutcome;
function readWire(raw: unknown, botId: string, preview: boolean): FreshStartPreview | FreshStartOutcome {
  const parsed = preview ? freshStartPreviewSchema.parse(raw) : freshStartOutcomeSchema.parse(raw);
  if (parsed.botId !== botId) throw new Error("unsupported");
  return parsed;
}
const base = (id: string) => `/api/memory/bots/${encodeURIComponent(id)}/fresh-start`;
const button = "min-h-10 rounded-lg border border-hairline/50 px-3 py-2 text-[13px] text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
// One unresolved request per bot, retained across dialog/pane unmount and reload.
// Only the same canonical body can reconcile it; opening never creates a new mutation.
type Pending = { botId: string; botName: string; request: ConfirmRequest; outcome?: FreshStartOutcome; flight?: Promise<FreshStartOutcome> };
const pending = new Map<string, Pending>();
const storageKey = (id: string) => `murage.fresh-start.pending.${encodeURIComponent(id)}`;
function remember(item: Pending) {
  pending.set(item.botId, item);
  try { sessionStorage.setItem(storageKey(item.botId), JSON.stringify({ botId: item.botId, botName: item.botName, request: item.request, ...(item.outcome ? { outcome: item.outcome } : {}) })); } catch { /* in-memory reconciliation still works */ }
}
function recall(id: string): Pending | undefined {
  const known = pending.get(id); if (known) return known;
  try {
    const v = JSON.parse(sessionStorage.getItem(storageKey(id)) ?? "null") as Pending | null;
    if (v?.botId === id && typeof v.botName === "string" && freshStartConfirmRequestSchema.safeParse(v.request).success) {
      const item: Pending = { botId: id, botName: v.botName, request: { previewToken: v.request.previewToken, confirm: true, idempotencyKey: v.request.idempotencyKey } };
      if (v.outcome) item.outcome = readWire(v.outcome, id, false);
      pending.set(id, item); return item;
    }
  } catch { /* unreadable local state cannot authorize a confirm */ }
  return undefined;
}
function forget(id: string) { pending.delete(id); try { sessionStorage.removeItem(storageKey(id)); } catch { /* private storage */ } }
function reconcile(item: Pending): Promise<FreshStartOutcome> {
  if (item.outcome && item.outcome.state !== "applying") return Promise.resolve(item.outcome);
  if (item.flight) return item.flight;
  item.flight = (item.outcome?.state === "applying"
    ? api(`${base(item.botId)}/operations/${encodeURIComponent(item.outcome.operationId)}`, undefined, 0)
    : api(`${base(item.botId)}/confirm`, { method: "POST", body: JSON.stringify(item.request) }, 0))
    .then(raw => { const outcome = readWire(raw, item.botId, false); item.outcome = outcome; remember(item); return outcome; })
    .finally(() => { item.flight = undefined; });
  return item.flight;
}

function blockedCopy(reason: BlockedReason, name: string) {
  switch (reason) {
    case "deletion-pending": return t("freshStart.deletionPending");
    case "bot-busy": return t("freshStart.botBusy", { botName: name });
    case "lineage-unready": return t("freshStart.lineageUnready");
    case "limit-exceeded": return t("freshStart.limitExceeded");
    case "unsupported-schema": return t("freshStart.unsupported");
    case "policy-unavailable": return t("freshStart.policyUnavailable");
  }
}
function outcomeCopy(outcome: FreshStartOutcome, name: string): string {
  if (outcome.state === "applying") return t("freshStart.applying", { botName: name });
  if (outcome.state === "done") return t("freshStart.done", { botName: name, freshSessions: outcome.freshSessions, clearedBlocks: outcome.clearedBlocks });
  if (outcome.state === "nothing-to-do") return t("freshStart.nothing", { botName: name });
  return blockedCopy(outcome.reason, name);
}
type View = { phase: "loading" | "committing" | "unknown" | "failed" | "unsupported" | "stale" } | { phase: "preview"; preview: FreshStartPreview } | { phase: "outcome"; outcome: FreshStartOutcome; botName: string };

function FreshStartDialog({ bot, onClose }: { bot: Pick<Bot, "id" | "name">; onClose: () => void }) {
  const [view, setView] = useState<View>({ phase: "loading" });
  const dialog = useRef<HTMLDivElement>(null), serial = useRef(0), inFlight = useRef(false);
  const titleId = useId(), consequenceId = useId();
  const layer = useFocusTrap(dialog, true, { name: "bot-fresh-start", kind: "dialog", initialFocus: "[data-cancel]", onEscape: () => close() });
  const resolve = async (item: Pending) => {
    if (inFlight.current) return;
    const revision = ++serial.current; inFlight.current = true;
    setView({ phase: "committing" });
    try {
      const outcome = await reconcile(item);
      if (revision === serial.current) setView({ phase: "outcome", outcome, botName: item.botName });
    } catch (cause) {
      if (revision !== serial.current) return;
      const status = (cause as { status?: number })?.status;
      if (status === 409 && (cause as { body?: { error?: string } })?.body?.error === "stale-preview") {
        // C1: only the absent-idempotency path can refuse a stale preview.
        // A committed request replays before the token/snapshot checks.
        forget(bot.id); setView({ phase: "stale" }); return;
      }
      if (status === 401 || status === 403 || status === 404) { onClose(); return; }
      // A missing/invalid response, 503 (including flush failure), or conflicting
      // retry cannot prove rollback. Keep the same request until resolved.
      setView({ phase: "unknown" });
    } finally { inFlight.current = false; }
  };
  const check = async () => {
    const unresolved = recall(bot.id);
    if (unresolved) { void resolve(unresolved); return; }
    const revision = ++serial.current;
    setView({ phase: "loading" });
    try {
      const raw: unknown = await api(`${base(bot.id)}/preview`, { method: "POST", body: "{}" }, 0);
      if (revision !== serial.current) return;
      let preview: FreshStartPreview;
      try { preview = readWire(raw, bot.id, true); } catch { setView({ phase: "unsupported" }); return; }
      if (preview.botName !== bot.name) { onClose(); return; }
      setView(preview.expiresAt <= Date.now() ? { phase: "stale" } : { phase: "preview", preview });
    } catch (cause) {
      if (revision !== serial.current) return;
      const status = (cause as { status?: number })?.status;
      if (status === 401 || status === 403) { onClose(); return; }
      setView({ phase: status === 404 ? "unsupported" : "failed" });
    }
  };
  useEffect(() => { void check(); return () => { serial.current++; }; }, []);
  useEffect(() => {
    if (view.phase !== "preview") return;
    const timer = window.setTimeout(() => setView({ phase: "stale" }), Math.max(0, view.preview.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [view]);
  const confirm = () => {
    if (inFlight.current || view.phase !== "preview" || view.preview.state !== "ready") return;
    if (view.preview.expiresAt <= Date.now()) { setView({ phase: "stale" }); return; }
    const item: Pending = { botId: bot.id, botName: view.preview.botName, request: { previewToken: view.preview.previewToken, confirm: true, idempotencyKey: crypto.randomUUID() } };
    remember(item); void resolve(item);
  };
  const close = () => { if (view.phase === "outcome" && view.outcome.state !== "applying") forget(bot.id); onClose(); };
  const busy = view.phase === "loading" || view.phase === "committing";
  const preview = view.phase === "preview" ? view.preview : null;
  const outcome = view.phase === "outcome" ? view.outcome : null;
  const name = preview?.botName ?? (view.phase === "outcome" ? view.botName : bot.name);
  let message: string;
  if (preview) message = preview.state === "ready" ? t("freshStart.preview", { staleBlocks: preview.staleBlocks, freshSessions: preview.freshSessions }) : preview.state === "nothing-to-do" ? t("freshStart.nothing", { botName: name }) : blockedCopy(preview.reason, name);
  else if (outcome) message = outcomeCopy(outcome, name);
  else message = t(view.phase === "loading" ? "freshStart.checking" : view.phase === "committing" ? "freshStart.committing" : view.phase === "unknown" ? "freshStart.unknown" : view.phase === "failed" ? "freshStart.failed" : view.phase === "stale" ? "freshStart.stale" : "freshStart.unsupported");
  const retry = ["unknown", "failed", "stale"].includes(view.phase) || preview?.state === "blocked" || outcome?.state === "blocked";
  return <LayerSurface handle={layer}><div className="overlay-inset fixed inset-x-0 top-0 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/60 p-3" role="presentation">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={consequenceId} tabIndex={-1} className={`${BOX_FRAME} max-h-[calc(var(--vvh,100dvh)-1.5rem)] w-full min-w-0 max-w-[460px] rounded-2xl border border-hairline bg-panel text-ink`}>
      <BoxHead className="px-5 pt-5"><h2 id={titleId} className="min-w-0 break-words text-[17px] font-medium">{t("freshStart.confirmTitle", { botName: name })}</h2></BoxHead>
      <BoxBody className="space-y-3 px-5 py-3"><p id={consequenceId} className="text-[13px] text-ink-secondary">{t("freshStart.consequence")}</p>
        <p role="status" aria-live="polite" aria-busy={busy} className="break-words text-[13px]">{message}</p>
        {(preview || outcome) && (preview ?? outcome)!.state !== "blocked" && <p className="text-[12px] text-ink-secondary">{t((preview ?? outcome)!.retainedCapped ? "freshStart.retainedCapped" : "freshStart.retained", { count: (preview ?? outcome)!.retainedBlocks })}</p>}
      </BoxBody>
      <BoxFoot className="flex flex-wrap justify-end gap-2 px-5 pb-5">
        <button type="button" data-cancel className={button} onClick={close}>{t(view.phase === "loading" || preview?.state === "ready" ? "freshStart.cancel" : "freshStart.close")}</button>
        {retry && <button type="button" className={button} onClick={() => { if (outcome?.state === "blocked") forget(bot.id); void check(); }}>{t("freshStart.checkAgain")}</button>}
        {preview?.state === "ready" && <button type="button" data-primary="true" className={`${button} bg-accent text-white`} onClick={confirm}>{t("freshStart.confirm")}</button>}
      </BoxFoot>
    </div>
  </div></LayerSurface>;
}

function FreshStartRow({ bot, status, clearStatus }: { bot: Pick<Bot, "id" | "name">; status?: FreshStartOutcome; clearStatus(): void }) {
  const [open, setOpen] = useState(false), [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();
  useEffect(() => onSignedOut(() => setOpen(false)), []);
  return <section id="bot-setting-clear-revoked-marks" data-setting="bot.memory.clear-revoked-marks" tabIndex={-1} className="rounded-xl bg-card p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
    <button type="button" className={`${button} inline-flex items-center gap-2`} onClick={() => { if (!sessionSignedOut()) { clearStatus(); setOpen(true); } }}><Brain size={18} aria-hidden="true" />{t("freshStart.label")}</button>
    <p className="mt-2 text-[12px] text-ink-secondary">{t("freshStart.helper")}</p>
    {status && <p role="status" aria-live="polite" className="mt-2 text-[13px] text-ink">{outcomeCopy(status, bot.name)}</p>}
    <button type="button" aria-label={t("freshStart.about")} aria-expanded={helpOpen} aria-controls={helpId} onClick={() => setHelpOpen(value => !value)} className="mt-1 inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"><Info size={16} aria-hidden="true" /></button>
    {helpOpen && <p id={helpId} className="mt-1 text-[12px] text-ink-secondary">{t("freshStart.help")}</p>}
    {open && <FreshStartDialog bot={bot} onClose={() => setOpen(false)} />}
  </section>;
}

export function BotFreshStartAction({ bot, active = true }: { bot: Pick<Bot, "id" | "name">; active?: boolean }) {
  const desktop = useDesktopSurface(), mode = useSettingsMode();
  const { state, dispatch } = useStore();
  const [observed, setObserved] = useState<FreshStartOutcome>();
  useEffect(() => onSignedOut(() => setObserved(undefined)), []);
  useEffect(() => {
    let current = true;
    if (!active || desktop !== true) { setObserved(undefined); return; }
    const item = recall(bot.id);
    setObserved(item?.outcome);
    // One read when the Memory section opens. No polling and no new confirm.
    if (item?.outcome?.state === "applying") void reconcile(item)
      .then(outcome => { if (current) setObserved(outcome); })
      .catch(() => { /* A failed read keeps the known applying state. */ });
    return () => { current = false; };
  }, [active, desktop, bot.id]);
  const status = observed?.botId === bot.id ? observed : undefined;
  if (desktop !== true || !active) return null;
  if (mode === "simple") return <div className="rounded-xl bg-card p-4"><p className="text-[13px] text-ink">{t("freshStart.label")}</p>{status && <p role="status" aria-live="polite" className="mt-2 text-[13px] text-ink">{outcomeCopy(status, bot.name)}</p>}<button type="button" className={`${button} mt-2`} onClick={() => openSettingsAddress({ scope: "bot", botId: bot.id, section: "memory", name: "clear-revoked-marks" }, { botIds: state.bots.map(b => b.id), selectedBotId: bot.id }, dispatch)}>{t("freshStart.setAdvanced")}</button></div>;
  return <FreshStartRow key={`${bot.id}:${bot.name}`} bot={bot} status={status} clearStatus={() => setObserved(undefined)} />;
}
