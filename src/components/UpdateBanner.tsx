// App-level auto-update strip, driven by the preload's updater bridge.
// Renders nothing in the browser/dev (no bridge) and while idle/checking —
// it only appears when there is something actionable: an update to
// download, a download in progress, a restart to apply, or an error.
import { useState } from "react";
import { ArrowDownToLine, RefreshCw, X } from "lucide-react";
import { useUpdaterState } from "@/lib/updater";

export function UpdateBanner() {
  const s = useUpdaterState();
  // dismissal is per status+version, so the banner comes back for the next
  // update (or when an available update finishes downloading)
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!s || s.status === "idle" || s.status === "checking") return null;
  const key = `${s.status}:${s.version ?? ""}`;
  if (dismissed === key) return null;
  const updater = window.ogb!.updater!;

  const action =
    s.status === "available" ? (
      <button
        onClick={() => void updater.download()}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-white"
      >
        <ArrowDownToLine size={13} /> Download
      </button>
    ) : s.status === "downloaded" ? (
      <button
        onClick={() => void updater.install()}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-white"
      >
        <RefreshCw size={13} /> Restart to update
      </button>
    ) : s.status === "error" ? (
      <button
        onClick={() => void updater.check()}
        className="shrink-0 rounded-lg bg-raised px-3 py-1 text-[12px] text-ink hover:bg-raised-hover"
      >
        Try again
      </button>
    ) : null;

  return (
    <div className="flex items-center gap-3 border-b border-hairline/40 bg-card px-4 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-secondary">
        {s.status === "available" && (
          <>
            <span className="font-medium text-ink">OpenMausBot {s.version}</span> is available.
          </>
        )}
        {s.status === "downloading" && (
          <>
            Downloading {s.version ?? "update"}… {Math.round(s.percent ?? 0)}%
          </>
        )}
        {s.status === "downloaded" && (
          <>
            <span className="font-medium text-ink">OpenMausBot {s.version}</span> is ready — restart
            to apply.
          </>
        )}
        {s.status === "error" && <>Update check failed: {s.message ?? "unknown error"}</>}
      </span>
      {s.status === "downloading" && (
        <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-raised">
          <span
            className="block h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${Math.min(100, Math.max(0, s.percent ?? 0))}%` }}
          />
        </span>
      )}
      {action}
      {s.status !== "downloading" && (
        <button
          onClick={() => setDismissed(key)}
          className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Dismiss"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
