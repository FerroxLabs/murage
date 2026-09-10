import { useEffect, useRef, useState } from "react";
import { api, useStore, type InstanceInfo } from "@/state/store";

type Status = { supported: boolean; updateAvailable: boolean; installedVersion?: string | null; latestVersion?: string; message: string; busy: boolean;
  source?: "managed" | "bundled" | "path" | "custom" | "unknown"; releaseSupported?: boolean; rollbackAvailable?: boolean; bundledAvailable?: boolean };
/** Explicit install/update actions; checking metadata never runs a model. */
export function EngineManagement({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
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
    try {
      setStatus(await api(url, { method: "POST", body: JSON.stringify({ action }) }));
      if (action !== "check") await refreshInstances();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update this engine. Try again.");
      if (action !== "check") {
        // Activation may have failed while restoring configuration. Do not
        // leave a stale source/version presented as the confirmed selection.
        setStatus(null);
        try { setStatus(await api(url)); await refreshInstances(); } catch { /* explicit retry check remains */ }
      }
    }
    finally { actionActive.current = false; setBusy(false); }
  };
  if (!status) return error ? <div className="mt-2 text-[12px]">
    <p role="alert" className="text-danger">{error}</p>
    <button type="button" onClick={() => setReload(value => value + 1)} className="mt-1 rounded-lg border border-hairline/40 px-3 py-2 text-ink">Retry update check</button>
  </div> : null;
  const missing = instance.snapshot.state !== "available";
  const fuigo = instance.driverKind === "fuigoAgent";
  const optIn = fuigo && status.source !== "managed" && status.source !== "bundled";
  return <div className="mt-2 text-[12px] text-ink-secondary">
    <p>{status.message}</p>
    {fuigo && <p className="mt-2">Selected source: {status.source ?? "unknown"} · Installed: {status.installedVersion ?? "not detected"}{status.latestVersion ? ` · Latest Fuigo: ${status.latestVersion}` : ""}</p>}
    {status.updateAvailable && <p role="status" className="mt-2 font-medium text-ink">Engine update available · {status.latestVersion}</p>}
    <div className="mt-2 flex flex-wrap gap-2">
      {(status.supported || instance.driverKind === "fuigoAgent") && <button type="button" disabled={busy || status.busy} onClick={() => void perform("check")} className="rounded-lg border border-hairline/40 px-3 py-2 text-ink disabled:opacity-50">{busy ? "Working…" : "Check for engine updates"}</button>}
      {status.supported && !optIn && (missing || status.updateAvailable) && <button type="button" disabled={busy || status.busy || status.releaseSupported === false} onClick={() => void perform(missing ? "install" : "update")} className="rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">{fuigo ? missing ? "Install native Fuigo" : "Update Fuigo" : missing ? "Install engine" : "Update"}</button>}
      {status.supported && optIn && <button type="button" disabled={busy || status.busy || status.releaseSupported === false} onClick={() => void perform("use-managed")} className="rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">Use managed Fuigo</button>}
      {fuigo && status.supported && status.rollbackAvailable && <button type="button" disabled={busy || status.busy} onClick={() => void perform("rollback")} className="rounded-lg border border-hairline/40 px-3 py-2 text-ink disabled:opacity-50">Use previous managed version</button>}
      {fuigo && status.supported && status.bundledAvailable && status.source !== "bundled" && <button type="button" disabled={busy || status.busy} onClick={() => void perform("use-bundled")} className="rounded-lg border border-hairline/40 px-3 py-2 text-ink disabled:opacity-50">Use bundled Fuigo</button>}
    </div>
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
  </div>;
}
