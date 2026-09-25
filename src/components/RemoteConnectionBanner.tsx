// WHEN THE COMPUTER CANNOT BE REACHED, SAY SO — ON THE PHONE.
//
// The desktop's banner (ServerLifecycleBanner) reports its own engine through
// the Electron bridge and is silent everywhere else. A phone or another
// browser reaching Murage through the door had nothing: the live stream
// dropped, `connected` went false, and the screen simply stopped changing.
//
// Driven by the same `connected` flag the event stream sets. A short grace
// keeps a resume or a network hand-off from flashing it.
//
// A cold start is not a loss: `connected` starts false at boot and the SSE
// stream only opens once `ensureDesktopSurfaceSecret()` resolves, so on a
// slow Tailscale or cellular cold start this page has never connected yet.
// That gets a longer grace (REMOTE_FIRST_CONNECT_GRACE_MS) than losing a
// connection this page already had (REMOTE_OFFLINE_GRACE_MS) — otherwise
// ordinary startup reads as "your computer is unreachable".
import { useEffect, useRef, useState } from "react";
import { WifiOff } from "lucide-react";

export const REMOTE_OFFLINE_GRACE_MS = 3_000;
export const REMOTE_FIRST_CONNECT_GRACE_MS = 15_000;

export function remoteConnectionNotice(input: {
  connected: boolean;
  signedOut: boolean;
  offlineSince: number | null;
  now: number;
  everConnected: boolean;
}): string | null {
  if (input.connected || input.signedOut || input.offlineSince === null) return null;
  const grace = input.everConnected ? REMOTE_OFFLINE_GRACE_MS : REMOTE_FIRST_CONNECT_GRACE_MS;
  if (input.now - input.offlineSince < grace) return null;
  // Not "the server": nobody installed a server. And it answers the real
  // question, which is whether what they typed is lost.
  return "Can't reach your Murage right now. Anything you type is kept, and this reconnects by itself once your computer is awake and online.";
}

export function RemoteConnectionBanner({ connected, signedOut }: { connected: boolean; signedOut: boolean }) {
  // A ref, not state: it only ever flips false -> true, and reading it during
  // render (rather than from an effect) means the very render that learns
  // `connected` is true also knows this page has now connected at least once.
  const everConnectedRef = useRef(false);
  if (connected) everConnectedRef.current = true;

  const [offlineSince, setOfflineSince] = useState<number | null>(() => (connected ? null : Date.now()));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connected) {
      setOfflineSince(null);
      return;
    }
    const since = Date.now();
    setOfflineSince((current) => current ?? since);
    const grace = everConnectedRef.current ? REMOTE_OFFLINE_GRACE_MS : REMOTE_FIRST_CONNECT_GRACE_MS;
    const timer = setTimeout(() => setNow(Date.now()), grace);
    return () => clearTimeout(timer);
  }, [connected]);

  const text = remoteConnectionNotice({
    connected,
    signedOut,
    offlineSince,
    now,
    everConnected: everConnectedRef.current,
  });
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
