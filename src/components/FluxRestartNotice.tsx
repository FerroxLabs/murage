import { useState } from "react";

const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const button = `min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink disabled:opacity-50 ${focus}`;

export const FLUX_RESTART_NEW_KEY = "Restart Murage to use the new key.";
export const FLUX_RESTART_REMOVED_KEY = "Restart Murage to stop using the old key.";
export const FLUX_RESTART_FAILED = "Murage could not restart itself. Quit Murage and open it again.";

export interface FluxRestartNoticeProps {
  /** The server says a key usable before a save was replaced or removed since this launch. */
  required: boolean;
  /** Whether a Flux key is saved now (wording only). */
  configured: boolean;
  /** Present only where the desktop app can restart itself. */
  onRestart?: () => Promise<void>;
}

/** After a Flux key change, engines already running keep the key they started
 * with. Turns that start after a restart use the saved key. */
export function FluxRestartNotice({ required, configured, onRestart }: FluxRestartNoticeProps) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!required) return null;
  const restart = async () => {
    if (!onRestart || busy) return;
    setBusy(true); setError("");
    try { await onRestart(); }
    catch { setError(FLUX_RESTART_FAILED); setBusy(false); }
  };
  return <div className="mt-3 rounded-lg bg-card p-3 text-[12px]">
    <p role="status" className="text-ink">{configured ? FLUX_RESTART_NEW_KEY : FLUX_RESTART_REMOVED_KEY}</p>
    {onRestart && <button type="button" className={`${button} mt-2`} disabled={busy} onClick={() => void restart()}>{busy ? "Restarting…" : "Restart Murage"}</button>}
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
  </div>;
}
