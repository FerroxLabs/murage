import { useEffect, useState } from "react";
import { api, useStore, type InstanceInfo } from "@/state/store";

type Status = { supported: boolean; updateAvailable: boolean; latestVersion?: string; message: string; busy: boolean };
/** Explicit install/update actions; checking metadata never runs a model. */
export function EngineManagement({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances, dispatch } = useStore();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
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
  const perform = async (action: "check" | "install" | "update") => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      setStatus(await api(url, { method: "POST", body: JSON.stringify({ action }) }));
      if (action !== "check") await refreshInstances();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update this engine. Try again."); }
    finally { setBusy(false); }
  };
  if (!status) return error ? <div className="mt-2 text-[12px]">
    <p role="alert" className="text-danger">{error}</p>
    <button type="button" onClick={() => setReload(value => value + 1)} className="mt-1 rounded-lg border border-hairline/40 px-3 py-2 text-ink">Retry update check</button>
  </div> : null;
  const missing = instance.snapshot.state !== "available";
  return <div className="mt-2 text-[12px] text-ink-secondary">
    <p>{status.message}</p>
    {status.updateAvailable && <p role="status" className="mt-2 font-medium text-ink">Engine update available · {status.latestVersion}</p>}
    <div className="mt-2 flex flex-wrap gap-2">
      {(status.supported || instance.driverKind === "fuigoAgent") && <button type="button" disabled={busy || status.busy} onClick={() => void perform("check")} className="rounded-lg border border-hairline/40 px-3 py-2 text-ink disabled:opacity-50">{busy ? "Working…" : "Check for engine updates"}</button>}
      {status.supported && (missing || status.updateAvailable) && <button type="button" disabled={busy || status.busy} onClick={() => void perform(missing ? "install" : "update")} className="rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">{missing ? "Install engine" : "Update"}</button>}
      {instance.driverKind === "fuigoAgent" && status.updateAvailable && <button type="button" onClick={() => dispatch({type:"toggleAppSettings",open:true,section:"general"})} className="rounded-lg bg-accent px-3 py-2 font-medium text-white">Update Murage</button>}
    </div>
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
  </div>;
}
