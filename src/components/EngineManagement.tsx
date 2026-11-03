import { useEffect, useRef, useState } from "react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";

type Status = { supported: boolean; updateAvailable: boolean; installedVersion?: string | null; latestVersion?: string; message: string; busy: boolean;
  source?: "managed" | "bundled" | "path" | "custom" | "unknown"; releaseSupported?: boolean; rollbackAvailable?: boolean; bundledAvailable?: boolean; progress?: Progress };
type Progress = { phase: "download" | "check" | "install"; received: number; total: number };
const POLL_MS = 500;

/** The words under the bar. A download counts its bytes; the two short steps after it say what they are doing. */
export function installProgressLine(progress: Progress): string {
  if (progress.phase === "check") return t("engineInstall.checking");
  if (progress.phase === "install") return t("engineInstall.finishing");
  const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return t("engineInstall.downloading", { done: mb(progress.received), total: mb(progress.total) });
}
function InstallProgress({ progress }: { progress: Progress }) {
  const percent = progress.total > 0 ? Math.min(100, Math.round(progress.received / progress.total * 100)) : 0;
  const line = installProgressLine(progress);
  return <div className="mt-2">
    <div role="progressbar" aria-label={line} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 w-full overflow-hidden rounded-full bg-inset">
      <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </div>
    <p role="status" className="mt-1 text-[11.5px] text-ink-secondary">{line}</p>
  </div>;
}
/** Explicit install/update actions; checking metadata never runs a model. */
export function EngineManagement({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const actionActive = useRef(false);
  const url = `/api/engine-management/${encodeURIComponent(instance.instanceId)}`;
  useEffect(() => {
    let active = true;
    setError(null);
    api(url).then(async (value: Status) => {
      if (active) setStatus(value);
      if (value.supported || instance.driverKind === "fuigoAgent") {
        const checked: Status = await api(url, { method: "POST", body: JSON.stringify({ action: "check" }) });
        if (active) setStatus(checked);
      }
    }).catch(() => { if (active) setError("Could not check engine updates. Check your connection and try again."); });
    return () => { active = false; };
  }, [url, instance.driverKind, reload]);
  const perform = async (action: "check" | "install" | "update" | "use-managed" | "rollback" | "use-bundled") => {
    if (actionActive.current) return;
    actionActive.current = true;
    setBusy(true); setError(null);
    // The install answers when it is done. While a press is live, the status read carries its progress.
    const poll = (action === "install" || action === "update") && instance.driverKind !== "fuigoAgent"
      ? setInterval(() => { api(url).then((value: Status) => { if (value.progress) setProgress(value.progress); }).catch(() => { /* the bar waits for the next read; the install answers for itself */ }); }, POLL_MS) : undefined;
    try {
      setStatus(await api(url, { method: "POST", body: JSON.stringify({ action }) }));
      // The action already succeeded once the POST answered. A failed engine
      // list refresh (refreshInstances rejects, FOLLOW4) must not read as
      // "could not update this engine": the status above is the server's.
      if (action !== "check") await refreshInstances().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update this engine. Try again.");
      if (action !== "check") {
        // Activation may have failed while restoring configuration. Do not
        // leave a stale source/version presented as the confirmed selection.
        setStatus(null);
        try { setStatus(await api(url)); await refreshInstances(); } catch { /* explicit retry check remains */ }
      }
    }
    finally { clearInterval(poll); setProgress(null); actionActive.current = false; setBusy(false); }
  };
  // Claude Code is here but too old to run: the same fixed update the chat offers, never a second install.
  const updateClaude = async () => {
    if (actionActive.current) return;
    actionActive.current = true;
    setBusy(true); setError(null);
    try {
      await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/claude-update`, { method: "POST", body: "{}" });
      await refreshInstances().catch(() => { /* the update already answered; the last list stays */ });
    } catch (e) { setError(e instanceof Error ? e.message : t("engineInstall.failed")); }
    finally { actionActive.current = false; setBusy(false); }
  };
  if (!status) return error ? <div className="mt-2 text-[12px]">
    <p role="alert" className="text-danger">{error}</p>
    <button type="button" onClick={() => setReload(value => value + 1)} className="mt-1 rounded-lg border border-hairline/40 px-3 py-2 text-ink">Retry update check</button>
  </div> : null;
  const missing = instance.snapshot.state !== "available";
  const fuigo = instance.driverKind === "fuigoAgent";
  const optIn = fuigo && status.source !== "managed" && status.source !== "bundled";
  const native = instance.install?.native === true;
  const claude = instance.driverKind === "claudeAgent";
  const claudeOutdated = claude && missing && !!instance.snapshot.version;
  return <div className="mt-2 text-[12px] text-ink-secondary">
    <p>{status.message}</p>
    {fuigo && <p className="mt-2">Selected source: {status.source ?? "unknown"} · Installed: {status.installedVersion ?? "not detected"}{status.latestVersion ? ` · Latest Fuigo: ${status.latestVersion}` : ""}</p>}
    {status.updateAvailable && <p role="status" className="mt-2 font-medium text-ink">Engine update available · {status.latestVersion}</p>}
    <div className="mt-2 flex flex-wrap gap-2">
      {claudeOutdated && <button type="button" disabled={busy || status.busy} onClick={() => void updateClaude()} className="rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">{busy ? "Working…" : t("engineInstall.update", { name: instance.displayName })}</button>}
      {(status.supported || instance.driverKind === "fuigoAgent") && !(native && missing) && <button type="button" disabled={busy || status.busy} onClick={() => void perform("check")} className="rounded-lg border border-hairline/40 px-3 py-2 text-ink disabled:opacity-50">{busy ? "Working…" : "Check for engine updates"}</button>}
      {status.supported && !optIn && (missing || status.updateAvailable) && <button type="button" disabled={busy || status.busy || status.releaseSupported === false} onClick={() => void perform(missing ? "install" : "update")} className="rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">{fuigo ? missing ? "Install native Fuigo" : "Update Fuigo" : missing ? t("engineInstall.install", { name: instance.displayName }) : "Update"}</button>}
      {status.supported && optIn && <button type="button" disabled={busy || status.busy || status.releaseSupported === false} onClick={() => void perform("use-managed")} className="rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">Use managed Fuigo</button>}
      {fuigo && status.supported && status.rollbackAvailable && <button type="button" disabled={busy || status.busy} onClick={() => void perform("rollback")} className="rounded-lg border border-hairline/40 px-3 py-2 text-ink disabled:opacity-50">Use previous managed version</button>}
      {fuigo && status.supported && status.bundledAvailable && status.source !== "bundled" && <button type="button" disabled={busy || status.busy} onClick={() => void perform("use-bundled")} className="rounded-lg border border-hairline/40 px-3 py-2 text-ink disabled:opacity-50">Use bundled Fuigo</button>}
    </div>
    {progress && <InstallProgress progress={progress} />}
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
  </div>;
}
