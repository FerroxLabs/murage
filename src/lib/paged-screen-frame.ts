// A screen frame that arrived in a bounded page (upstream #1527): the server
// sends `hasImage` instead of the pixels and serves them from the message's
// image route. Fetched rather than put in an <img src>, because the route
// answers by surface and an image request cannot carry the desktop's proof.
import { useEffect, useState } from "react";
import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "@/lib/live-events";
import { screenFramePath } from "@/lib/image-thumbnail";
import { isPhoneClient } from "@/lib/phone-client";

export interface ScreenFramePixels {
  png: string;
  mime: string;
}

async function fetchScreenFrame(threadId: string, messageId: string): Promise<ScreenFramePixels | null> {
  await ensureDesktopSurfaceSecret();
  const res = await fetch(screenFramePath(threadId, messageId, isPhoneClient()), { headers: desktopSurfaceHeaders() });
  if (!res.ok) return null;
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return { png: btoa(binary), mime: blob.type || "image/png" };
}

/** The pixels of one screen message, or null until (unless) they arrive.
 * `messageId` undefined fetches nothing. */
export function usePagedScreenFrame(threadId: string, messageId: string | undefined): ScreenFramePixels | null {
  const [frame, setFrame] = useState<{ key: string; pixels: ScreenFramePixels } | null>(null);
  const key = messageId ? `${threadId}:${messageId}` : "";
  useEffect(() => {
    if (!messageId) return;
    let cancelled = false;
    fetchScreenFrame(threadId, messageId)
      .then((pixels) => {
        if (!cancelled && pixels) setFrame({ key: `${threadId}:${messageId}`, pixels });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [threadId, messageId]);
  return frame && frame.key === key ? frame.pixels : null;
}
