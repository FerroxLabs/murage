// The page's own media: chat voice messages, audio artifacts and the media
// player, all plain <audio> and <video> elements under the call overlay.

/** Pauses every audio and video element on the page. A native call does this
 *  BEFORE it opens (spec §4.3.3), so a WebKit audio session change caused by
 *  the pause lands before native activates its own, never after. */
export function pauseAllPageMedia(root: Pick<ParentNode, "querySelectorAll"> | undefined = globalThis.document): void {
  if (!root) return;
  for (const element of root.querySelectorAll("audio, video")) {
    const media = element as HTMLMediaElement;
    try {
      if (!media.paused) media.pause();
    } catch {
      // detached or already gone: nothing is playing
    }
  }
}
