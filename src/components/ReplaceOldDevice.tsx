import { useState } from "react";

import type { PhoneDevice } from "./PhoneSetupFlow";

/** "5 min ago", for a device list. */
export function lastSeenLabel(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** The pairing screen's answer to a full fleet.
 *
 * The companion only sends `candidates` once every slot is taken, already
 * sorted least recently seen first (`DeviceRegistry.replaceCandidates`), so
 * this renders them as given and never re-sorts. Replacing is the ordinary
 * revoke. The pairing code on screen survives it, so the phone that was
 * refused taps Try again and is in.
 *
 * Two taps, "Replace" then "Remove <name>?", because a revoke has no undo and
 * the list is exactly the owner's own devices. */
export function ReplaceOldDevice({
  candidates,
  max,
  busy,
  onReplace,
}: {
  candidates: PhoneDevice[];
  max?: number;
  busy: boolean;
  onReplace: (deviceId: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (!candidates.length) return null;
  return (
    <div
      role="group"
      aria-label="Replace an old device"
      className="mt-4 w-full max-w-[390px] rounded-xl border border-hairline/40 px-4 py-3 text-left"
    >
      <div className="text-[13px] font-medium text-ink">Replace an old device</div>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
        This computer already has {max ?? candidates.length} devices, so a new one can't join. Remove one you no
        longer use. The code on screen keeps working.
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {candidates.map((device) => {
          const seen = lastSeenLabel(device.lastSeenAt);
          return (
            <li key={device.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[12.5px] text-ink">{device.name}</div>
                <div className="text-[11px] text-ink-secondary">Last seen {seen}</div>
              </div>
              <ReplaceDeviceAction
                name={device.name}
                seen={seen}
                busy={busy}
                confirming={confirming === device.id}
                onAsk={() => setConfirming(device.id)}
                onCancel={() => setConfirming(null)}
                onConfirm={() => {
                  setConfirming(null);
                  onReplace(device.id);
                }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One row's action: "Replace" only asks; "Remove <name>?" revokes. */
export function ReplaceDeviceAction({
  name,
  seen,
  busy,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
}: {
  name: string;
  seen: string;
  busy: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!confirming) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={onAsk}
        aria-label={`Replace ${name}, last seen ${seen}`}
        className="min-h-9 shrink-0 rounded-lg px-3 text-[12px] text-danger hover:bg-control disabled:opacity-40"
      >
        Replace
      </button>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={onConfirm}
        className="min-h-9 rounded-lg bg-danger px-3 text-[12px] font-medium text-white disabled:opacity-40"
      >
        Remove {name}?
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onCancel}
        className="min-h-9 rounded-lg px-2 text-[12px] text-ink-secondary hover:bg-control disabled:opacity-40"
      >
        Cancel
      </button>
    </div>
  );
}
