import { Suspense, useEffect, useRef, useState } from "react";
import { IMAGE_GENERATION_REFERENCE_MAX } from "../../shared/media-assets";
import type { ImageModelCapabilities } from "../../shared/image-capabilities";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";

/** Saved prompt blocks and reference packs load only when opened. */
const Library = retryableLazy(() => import("./ImageLibrary"));

/** Mirrors `ImageModelOption` in server/image-generation.ts. Capability fields
 * are optional here so a snapshot from an older server never crashes the view;
 * the view then states less, never more. */
export interface ImageModel {
  id: string; label: string; generate: boolean; edit: boolean;
  availability: "unverified" | "catalog-listed" | "verified" | "failed"; disabledReason?: string;
  /** The model's last check on this connection (ms since epoch), and why it failed. */
  lastGoodAt?: number; lastFailedAt?: number; lastError?: string;
  /** Flux: false when the key's own model list does not name it. */
  offeredToKey?: boolean;
  /** What the Flux catalogue says about the model, when it says. */
  status?: { state: string };
  qualities: string[]; sizes: string[];
  /** Most reference images the adapter sends for one edit; 0 when editing is unavailable. */
  maxReferences?: number;
  /** Why editing is unavailable for this model, when it is. */
  editUnavailableReason?: string;
  /** Edit-specific quality support when it differs from generation. */
  editQualities?: string[];
  /** The full per-model statement (image generation v2); absent from older servers. */
  capabilities?: ImageModelCapabilities;
  /** An older id standing for a base model at a fixed quality and size. */
  aliasOf?: string;
}
export interface ImageSettingsSnapshot {
  enabled: boolean;
  connections: Array<{ id: string; label: string; provider: string }>;
  selected: { connectionId: string; model: string } | null;
  catalog: { connectionId: string; provider: string; defaultModel: string | null; models: ImageModel[]; capabilitySource?: "catalogue" | "built-in" } | null;
  /** Why the chosen connection's models could not be read. */
  catalogError?: string;
  /** The owner's "Check the default model once a day" (off by default). */
  dailyProbe?: boolean;
}
export interface ImageSettingsPatch { enabled?: boolean; connectionId?: string; model?: string; dailyProbe?: boolean }

/** "5 minutes ago", "2 hours ago", "3 days ago". Pure, for tests. */
export function relativeTime(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** What Murage knows about whether this model works for this key: its own
 * last check first, then the provider's list. A failed model is marked,
 * never hidden. Pure, for tests. */
export function imageModelCheckLines(model: ImageModel, now = Date.now()): string[] {
  const lines: string[] = [];
  if (model.availability === "failed" && model.lastFailedAt !== undefined) lines.push(t("imageSettings.check.failed", { when: relativeTime(model.lastFailedAt, now), reason: model.lastError || "no reason given" }));
  if (model.lastGoodAt !== undefined) lines.push(t("imageSettings.check.lastWorked", { when: relativeTime(model.lastGoodAt, now) }));
  if (model.offeredToKey === false) lines.push(t("imageSettings.check.notOffered"));
  if (model.status?.state) lines.push(t("imageSettings.check.fluxStatus", { state: model.status.state }));
  if (!lines.length) lines.push(model.availability === "catalog-listed" ? "Listed by the provider. Account access is checked when a request runs." : t("imageSettings.check.notChecked"));
  return lines;
}

export type ImageModelCapability =
  | { kind: "disabled"; sentences: string[] }
  | { kind: "edits"; sentences: string[]; maxReferences: number | null }
  | { kind: "generates"; sentences: string[] };

/**
 * The truthful capability statement for one catalog model. `edit` is the only
 * thing that promises editing; a positive `maxReferences` on an `edit:false`
 * model is never read as support. The reference count shown is clamped to
 * Murage's shared cap so the settings can never advertise more than an edit
 * will accept. Pure, for tests.
 */
export function imageModelCapability(model: ImageModel): ImageModelCapability {
  if (model.disabledReason) return { kind: "disabled", sentences: [model.disabledReason] };
  if (!model.generate) return { kind: "disabled", sentences: [t("imageSettings.model.disabled")] };
  if (!model.edit) return { kind: "generates", sentences: [t("imageSettings.model.createsOnly"), model.editUnavailableReason?.trim() || t("imageSettings.model.editUnavailable")] };
  const raw = model.maxReferences;
  const maxReferences = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 ? Math.min(raw, IMAGE_GENERATION_REFERENCE_MAX) : null;
  const sentences = [t("imageSettings.model.createsAndEdits"),
    maxReferences === null ? t("imageSettings.model.referenceLimitUnknown") : maxReferences === 1 ? t("imageSettings.model.referenceLimitOne") : t("imageSettings.model.referenceLimit", { count: maxReferences })];
  if (Array.isArray(model.editQualities)) {
    const qualities = model.editQualities.filter(quality => typeof quality === "string" && quality.trim());
    if (!qualities.length) sentences.push(t("imageSettings.model.editNoQuality"));
    else if (qualities.join(",") !== model.qualities.join(",")) sentences.push(t("imageSettings.model.editQualities", { qualities: qualities.join(", ") }));
  }
  return { kind: "edits", sentences, maxReferences };
}

/** A model's own limits in plain words, and for Flux whether they came from
 * the router or Murage's built-in table. Pure, for tests. */
export function imageModelLimits(capabilities: ImageModelCapabilities, source?: "catalogue" | "built-in"): string {
  const budget = `Prompt budget: ${capabilities.maxPromptChars.toLocaleString("en-US")} characters${capabilities.promptBudgetNote ? ` (${capabilities.promptBudgetNote.replace(/\.$/, "")})` : ""}.`;
  const details = source === "catalogue" ? " Model details: from Flux." : source === "built-in" ? " Model details: built in." : "";
  return `${budget} Sizes: ${capabilities.sizeRuleText}${details}`;
}

/** The dropdown suffix for one model: what it can do here, at a glance. */
export function imageModelOptionLabel(model: ImageModel, defaultModel: string | null): string {
  const notes: string[] = [];
  if (model.id === defaultModel) notes.push(t("imageSettings.option.default"));
  if (!model.generate || model.disabledReason) notes.push(t("imageSettings.option.unavailable"));
  else notes.push(model.edit ? t("imageSettings.option.edits") : t("imageSettings.option.createsOnly"));
  return `${model.label} · ${notes.join(" · ")}`;
}

const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const select = `mt-1.5 min-h-11 w-full min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50 ${focus}`;

/** Provider credentials and generation stay on the server; this selects an existing connection. */
export function ImageSettings() {
  const [snapshot, setSnapshot] = useState<ImageSettingsSnapshot | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [probing, setProbing] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const request = async (patch?: ImageSettingsPatch) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(patch ? "save" : "load"); setError(""); setNotice("");
    try {
      const next: ImageSettingsSnapshot = await api("/api/images/settings", patch ? { method: "POST", body: JSON.stringify(patch) } : undefined);
      if (mounted.current) { setSnapshot(next); if (patch) setNotice("Image settings saved."); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not load or save image settings.");
    } finally {
      inFlight.current = false; if (mounted.current) setBusy(null);
    }
  };
  useEffect(() => { mounted.current = true; void request(); return () => { mounted.current = false; }; }, []);
  // One check, started by the owner's click after the confirmation line.
  const probe = async (connectionId: string, model: string) => {
    if (inFlight.current) return;
    inFlight.current = true; setProbing(true); setError(""); setNotice("");
    try {
      const result: { probe: { ok: boolean; errorMessage?: string }; settings: ImageSettingsSnapshot } = await api("/api/images/probe", { method: "POST", body: JSON.stringify({ connectionId, model }) });
      if (mounted.current) { setSnapshot(result.settings); if (result.probe.ok) setNotice(t("imageSettings.check.passed")); else setError(result.probe.errorMessage ?? "The check failed."); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "The check could not run.");
    } finally { inFlight.current = false; if (mounted.current) setProbing(false); }
  };
  return <ImageSettingsView snapshot={snapshot} busy={busy} error={error} notice={notice} onChange={patch => void request(patch)} onRefresh={() => void request()}
    probing={probing} onProbe={(connectionId, model) => void probe(connectionId, model)} />;
}

export interface ImageSettingsViewProps {
  snapshot: ImageSettingsSnapshot | null;
  busy: "load" | "save" | null;
  error: string;
  notice: string;
  onChange: (patch: ImageSettingsPatch) => void;
  onRefresh: () => void;
  /** Owner-only model check. Absent in older views and tests. */
  probing?: boolean;
  onProbe?: (connectionId: string, model: string) => void;
}

/** Pure presentation of one settings snapshot. Every capability claim comes from the server's per-model record. */
export function ImageSettingsView({ snapshot, busy, error, notice, onChange, onRefresh, probing = false, onProbe }: ImageSettingsViewProps) {
  const [confirming, setConfirming] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const connectionId = snapshot?.selected?.connectionId ?? snapshot?.catalog?.connectionId ?? "";
  const connection = snapshot?.connections.find(item => item.id === connectionId);
  const catalog = snapshot?.catalog?.connectionId === connectionId ? snapshot.catalog : null;
  const modelId = snapshot?.selected?.connectionId === connectionId ? snapshot.selected.model : "";
  const model = catalog?.models.find(item => item.id === modelId);
  const capability = model ? imageModelCapability(model) : null;
  const usable = Boolean(model?.generate && !model.disabledReason);

  return <section aria-labelledby="image-settings-heading" className="min-w-0 rounded-xl border border-hairline/40 p-4">
    <h3 id="image-settings-heading" className="text-[14px] font-medium text-ink">Image generation</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">Let bots create or edit images using an existing connection. Flux defaults to GPT Image 2.5 Flare high.</p>
    <label className="mt-3 flex min-h-11 items-center gap-3 text-[13px] text-ink">
      <input type="checkbox" checked={snapshot?.enabled ?? false} disabled={!snapshot || Boolean(busy) || (!snapshot.enabled && !usable)}
        onChange={event => onChange({ enabled: event.target.checked })} className={`size-4 shrink-0 accent-accent ${focus}`} />
      Allow image requests
    </label>
    {snapshot?.connections.length === 0 ? <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">No supported image connections are available. Set up an image provider in Murage, then refresh this list.</p> : <>
      <label className="mt-3 block text-[13px] text-ink">Connection
        <select aria-label="Image connection" value={connectionId} disabled={!snapshot || Boolean(busy)} onChange={event => onChange({ connectionId: event.target.value })} className={select}>
          <option value="" disabled>Choose a connection</option>
          {snapshot?.connections.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label className="mt-3 block text-[13px] text-ink">Image model
        <select aria-label="Image model" value={modelId} disabled={!catalog || Boolean(busy)} onChange={event => onChange({ connectionId, model: event.target.value })} className={select}>
          <option value="" disabled>Choose an image model</option>
          {modelId && !model && <option value={modelId} disabled>{modelId}: unavailable</option>}
          {catalog?.models.map(item => <option key={item.id} value={item.id} disabled={!item.generate || Boolean(item.disabledReason)}>{imageModelOptionLabel(item, catalog.defaultModel)}</option>)}
        </select>
      </label>
      {snapshot?.catalogError && <p role="alert" className="mt-2 text-[12px] text-danger">{snapshot.catalogError}</p>}
      {catalog?.provider === "xai" && !modelId && <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">GPT Image 2 is not available on this connection. Choose an Imagine model to use xAI.</p>}
      {model && capability && <p data-image-capability={capability.kind} className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{capability.sentences.join(" ")}</p>}
      {model && usable && model.capabilities && <p data-image-limits className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{imageModelLimits(model.capabilities, catalog?.provider === "flux" ? catalog.capabilitySource : undefined)}</p>}
      {model && <p data-image-check={model.availability} className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{imageModelCheckLines(model).join(" ")}</p>}
      {model && usable && onProbe && (confirming ? <div className="mt-2 rounded-lg border border-hairline/40 p-2">
        <p className="text-[12px] leading-relaxed text-ink">{t("imageSettings.check.confirm")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={probing || Boolean(busy)} onClick={() => { setConfirming(false); onProbe(connectionId, model.id); }} className={`min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink disabled:opacity-50 ${focus}`}>{t("imageSettings.check.confirmButton")}</button>
          <button type="button" onClick={() => setConfirming(false)} className={`min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink ${focus}`}>{t("imageSettings.check.cancel")}</button>
        </div>
      </div> : <button type="button" disabled={probing || Boolean(busy)} onClick={() => setConfirming(true)} className={`mt-2 min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink disabled:opacity-50 ${focus}`}>{probing ? t("imageSettings.check.running") : t("imageSettings.check.now")}</button>)}
      {snapshot && onProbe && <label className="mt-3 flex min-h-11 items-center gap-3 text-[13px] text-ink">
        <input type="checkbox" checked={snapshot.dailyProbe === true} disabled={Boolean(busy)} onChange={event => onChange({ dailyProbe: event.target.checked })} className={`size-4 shrink-0 accent-accent ${focus}`} />
        <span>{t("imageSettings.check.daily")}<span className="block text-[12px] text-ink-secondary">{t("imageSettings.check.dailyNote")}</span></span>
      </label>}
      {catalog && !usable && <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">Choose an available model before enabling image requests.</p>}
      {connection && <p className="mt-3 text-[12px] leading-relaxed text-ink-secondary">Images use {connection.label}, with that connection’s account. Murage will not switch providers if a request fails.</p>}
    </>}
    <p className="mt-3 text-[12px] leading-relaxed text-ink-secondary">One image request per bot turn. You review and approve each image request before it runs. Editing is offered only when the selected model supports it.</p>
    {onProbe && (libraryOpen ? <LazyBoundary inline onRetry={Library.retry} onDismiss={() => setLibraryOpen(false)}>
      <Suspense fallback={<p role="status" className="mt-3 text-[12px] text-ink-secondary">{t("imageLibrary.busy")}</p>}><Library.Component /></Suspense>
    </LazyBoundary> : <button type="button" onClick={() => setLibraryOpen(true)} className={`mt-3 block min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink ${focus}`}>{t("imageSettings.library.open")}</button>)}
    <button type="button" onClick={onRefresh} disabled={Boolean(busy)} className={`mt-3 min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink disabled:opacity-50 ${focus}`}>{busy === "load" ? "Loading connections…" : "Refresh connections"}</button>
    {busy === "save" && <p role="status" className="mt-2 text-[12px] text-ink-secondary">Saving image settings…</p>}
    {notice && <p role="status" className="mt-2 text-[12px] text-success">{notice}</p>}
    {error && <p role="alert" className="mt-2 break-words text-[12px] text-danger">{error} Refresh to check the saved settings, then try again.</p>}
  </section>;
}
