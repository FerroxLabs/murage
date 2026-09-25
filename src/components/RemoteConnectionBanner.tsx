// WHEN THE COMPUTER CANNOT BE REACHED, SAY SO — ON THE PHONE.
//
// The desktop's banner (ServerLifecycleBanner) reports its own engine through
// the Electron bridge and is silent everywhere else. A phone or another
// browser reaching Murage through the door had nothing: the live stream
// dropped, `connected` went false, and the screen simply stopped changing.
//
// Driven by the same `connected` flag the event stream sets. A short grace
// keeps a resume or a network hand-off from flashing it.
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

export const REMOTE_OFFLINE_GRACE_MS = 3_000;

export function remoteConnectionNotice(input: {
  connected: boolean;
  signedOut: boolean;
  offlineSince: number | null;
  now: number;
}): string | null {
  if (input.connected || input.signedOut || input.offlineSince === null) return null;
  if (input.now - input.offlineSince < REMOTE_OFFLINE_GRACE_MS) return null;
  // Not "the server": nobody installed a server. And it answers the real
  // question, which is whether what they typed is lost.
  return "Can't reach your Murage right now. Anything you type is kept, and this reconnects by itself once your computer is awake and online.";
}

export function RemoteConnectionBanner({ connected, signedOut }: { connected: boolean; signedOut: boolean }) {
  const [offlineSince, setOfflineSince] = useState<number | null>(() => (connected ? null : Date.now()));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connected) {
      setOfflineSince(null);
      return;
    }
    const since = Date.now();
    setOfflineSince((current) => current ?? since);
    const timer = setTimeout(() => setNow(Date.now()), REMOTE_OFFLINE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  const text = remoteConnectionNotice({ connected, signedOut, offlineSince, now });
  if (!text) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 bg-raised px-4 py-2 text-[13px] font-medium text-ink"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.5rem)" }}
    >
      <WifiOff size={14} className="shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}
