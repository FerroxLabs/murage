import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MonitorCog,
  Power,
  RotateCcw,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { emergencyStopWarning } from "@/lib/emergency-stop";
import { api } from "@/state/store";
import { useDesktopCapabilities } from "./DesktopCapabilities";

const LINUX_GUIDE_URL =
  "https://github.com/FerroxLabs/murage/blob/main/docs/linux-desktop.md#enable-local-control";

export function LinuxLocalControl() {
  const { capabilities } = useDesktopCapabilities();
  const local = capabilities.localComputer;
  const [pending, setPending] = useState<"enable" | "disable" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const windows = capabilities.host.platform === "win32";
  if (capabilities.host.platform !== "linux" && !windows) return null;
  const busy = pending !== null || local.status === "checking" || local.status === "starting";
  const ready = local.available;
  const waylandSafetyBlocked = local.reasonCode === "linux-wayland-seat-safety-blocked";
  const wayland = capabilities.host.session === "wayland";
  const bundledDriver = local.driverSource === "bundled";

  const run = async (action: "enable" | "disable" | "retry") => {
    if (!window.muragebox?.localControl) return;
    setPending(action);
    setError(null);
    if (action === "disable") {
      // DESIGN 1022-cua-windows D17(c): Disable is called FIRST and always; the stop sweep is sent after it and
      // neither waits for the other. A sweep that fails or never answers is one warning line and changes nothing
      // about Disable.
      let disabling: Promise<unknown>;
      try { disabling = Promise.resolve(window.muragebox.localControl.disable()); } catch (reason) { disabling = Promise.reject(reason); }
      void api("/api/local-computer/interrupt", { method: "POST" }).then(
        (answer) => { const warning = emergencyStopWarning(answer); if (warning) setError((current) => current ? `${warning} ${current}` : warning); },
        (reason) => { const message = reason instanceof Error ? reason.message : String(reason); setError((current) => current ? `${current} ${message}` : message); },
      );
      try { await disabling; }
      catch (reason) { const message = reason instanceof Error ? reason.message : String(reason); setError((current) => current ? `${current} ${message}` : message); }
      finally { setPending(null); }
      return;
    }
    // The stop answers 200 even when a task did not confirm it stopped, so
    // the driver is still disabled; the person is told in one line.
    let stopWarning: string | null = null;
    try {
      if (action === "retry") {
        stopWarning = emergencyStopWarning(await api("/api/local-computer/interrupt", { method: "POST" }));
        if (stopWarning) setError(stopWarning);
      }
      await window.muragebox.localControl[action]();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(stopWarning ? `${stopWarning} ${message}` : message);
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="mt-4 rounded-xl bg-card p-4" aria-labelledby="linux-local-control-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div id="linux-local-control-title" className="flex items-center gap-2 text-[15px] font-medium text-ink">
            <MonitorCog size={16} className={ready ? "text-success" : "text-ink-secondary"} />
            Local control
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
            {windows ? "Beta · Windows 10/11 x64 · Cua Driver 0.55.0" : <>Beta · Ubuntu 24.04 GNOME/{wayland ? "Wayland" : "Xorg"} · Cua Driver 0.55.0</>}
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-1 text-[10px] font-medium",
            ready
              ? "bg-success/10 text-success"
              : waylandSafetyBlocked
                ? "bg-danger/10 text-danger"
                : local.enabled
                  ? "bg-warning/10 text-warning"
                  : "bg-raised text-ink-secondary",
          )}
        >
          {ready ? "Ready" : waylandSafetyBlocked ? "Unavailable on Wayland" : local.enabled ? "Needs attention" : "Off"}
        </span>
      </div>

      {waylandSafetyBlocked ? (
        <div className="mt-3 rounded-lg border border-danger/20 bg-danger/5 p-3">
          <div className="flex gap-2 text-[12px] leading-relaxed text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
            <span>
              Local control is available on Ubuntu Xorg. It remains disabled on Wayland until its input
              protection is validated. Sign out and choose <strong className="font-medium text-ink">Ubuntu on Xorg</strong>
              {" "}to use This computer; Chat, Cloud, Local VM, and screen preview still work here.
            </span>
          </div>
        </div>
      ) : !local.enabled ? (
        <div className="mt-3 rounded-lg border border-warning/20 bg-warning/5 p-3">
          <div className="flex gap-2 text-[12px] leading-relaxed text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>
              Enabling lets bots you explicitly assign to <strong className="font-medium text-ink">This computer</strong>{" "}
              inspect the active desktop and request mouse or keyboard actions. Every local action asks you first.
              {wayland && " GNOME may also ask you to allow foreground input for this desktop session."}
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg bg-panel p-3 text-[12px] text-ink-secondary">
          <div className="flex items-start gap-2">
            {ready ? (
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
            ) : busy ? (
              <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin" />
            ) : (
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            )}
            <span aria-live="polite">
              {ready
                ? "Ready for bots explicitly assigned to this computer. Bot actions use a private cursor, so your pointer stays under your control."
                : local.message ?? "Checking the driver and desktop session…"}
            </span>
          </div>
          {local.driverPath && (
            <div className="mt-2 break-all font-mono text-[10px] text-ink-secondary/80" title={local.driverPath}>
              {bundledDriver ? "Bundled Cua Driver" : local.driverPath}
              {local.driverVersion ? ` · ${local.driverVersion}` : ""}
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}

      {!waylandSafetyBlocked && <div className="mt-3 flex gap-2">
        {!local.enabled ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("enable")}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {pending === "enable" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            Enable local control (Beta)
          </button>
        ) : (
          <>
            {!ready && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run("retry")}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "retry" ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                Try again
              </button>
            )}
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void run("disable")}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {pending === "disable" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
              Disable local control
            </button>
          </>
        )}
      </div>}

      <button
        type="button"
        onClick={() => window.open(LINUX_GUIDE_URL, "_blank", "noopener,noreferrer")}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink"
      >
        {capabilities.host.packaged ? "Local control guide" : "Driver setup and troubleshooting"}{" "}
        <ExternalLink size={11} />
      </button>
    </section>
  );
}
