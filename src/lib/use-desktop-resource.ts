import { useCallback, useEffect, useRef, useState } from "react";

import { resourceNeedsTicket, ticketedResourceUrl } from "./live-events";

/** A URL the browser loads on its own (<img src>), as a React value.
 *
 * In the desktop window an /api URL needs a single-use ticket, which takes one
 * request to mint, so the value is `undefined` until it arrives. Every other
 * URL, and every URL in a window without the launch proof, comes back
 * unchanged on the first render.
 *
 * `retry()` asks for one fresh ticket after a load failed: an `<img
 * loading="lazy">` scrolled into view after its ticket expired, for instance.
 * It answers false when there is nothing to retry (the caller then shows its
 * own failure). */
export function useDesktopResourceUrl(url: string | null | undefined): { src: string | undefined; retry: () => boolean } {
  const ticketed = resourceNeedsTicket(url);
  const [minted, setMinted] = useState<{ for: string; round: number; url: string } | null>(null);
  const [round, setRound] = useState(0);
  const retries = useRef<{ for: string | null | undefined; count: number }>({ for: url, count: 0 });
  if (retries.current.for !== url) retries.current = { for: url, count: 0 };

  useEffect(() => {
    if (!ticketed || !url) return;
    let live = true;
    void ticketedResourceUrl(url).then((next) => {
      if (live) setMinted({ for: url, round, url: next });
    });
    return () => {
      live = false;
    };
  }, [url, ticketed, round]);

  const retry = useCallback(() => {
    if (!ticketed || retries.current.count >= 1) return false;
    retries.current.count += 1;
    setRound((value) => value + 1);
    return true;
  }, [ticketed]);

  if (!ticketed) return { src: url ?? undefined, retry };
  return { src: minted && minted.for === url && minted.round === round ? minted.url : undefined, retry };
}
