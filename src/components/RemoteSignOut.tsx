import { useState } from "react";

import { afterSignOut, signOutThisDevice } from "../lib/remote-sign-out";
import { Card } from "./SettingsPrimitives";

/** The one piece of device management that belongs on the device: removing
 * itself. Everything else about paired devices lives on the computer.
 *
 * Two taps, because the way back is a QR code on a computer that may be at
 * home. */
export function RemoteSignOut() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = async () => {
    setBusy(true);
    setError(null);
    const result = await signOutThisDevice();
    if (result.ok) {
      afterSignOut();
      return;
    }
    setBusy(false);
    setError(result.error);
  };

  return (
    <Card
      title="This device"
      subtitle="Removes this device from your computer. To use Murage here again, scan the code in Settings → Phone on the computer."
    >
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void signOut()}
            className="min-h-11 rounded-lg bg-danger px-4 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {busy ? "Signing out…" : "Sign out"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
            className="min-h-11 rounded-lg px-4 text-[13px] text-ink-secondary hover:bg-control disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="min-h-11 rounded-lg border border-hairline/60 px-4 text-[13px] text-danger hover:bg-control"
        >
          Sign out this device
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
