// F5-T3: the decisions a media card makes before it plays a sound, and the
// markup it renders. The renderer suite runs in node with no DOM, so this file
// pins the pure rules (codec support, failure sentences, the one-player
// floor, formatting) and the closed-state markup. Real playback, seeking
// through 206 responses, pause-on-unmount and the single-active-audio rule in
// a live document are proved in a browser by src/e2e/media-player.human.spec.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  canPlayMedia,
  claimMediaPlayback,
  formatMediaBytes,
  formatMediaDuration,
  LocalMedia,
  localMediaRequestFor,
  MediaPlayerCard,
  MediaUnplayableCard,
  MEDIA_EXPIRY_MARGIN_MS,
  mediaErrorMessage,
  mediaSourceExpired,
  mediaSourceLabel,
  releaseMediaPlayback,
  shouldRefreshMediaSource,
  unplayableMessage,
  __playingMediaForTests,
  type MediaSupportProbe,
} from "./MediaPlayer";
import type { MediaAsset } from "../../shared/media-assets";

const URL_WITH_CAP = "/api/media/bytes/ma1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?cap=mc1.claims.signature";

const audioAsset: MediaAsset = {
  id: "ma1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  scope: { serverId: "local", botId: "research", threadId: "task-7" },
  source: "workspace",
  kind: "audio",
  name: "take-2.wav",
  mime: "audio/wav",
  bytes: 90_044,
  revision: "r1.abcdefgh",
  availability: "ready",
  capabilities: { preview: true, download: true, open: false, reveal: false, imageReference: false },
};
const videoAsset: MediaAsset = { ...audioAsset, kind: "video", mime: "video/webm", name: "demo.webm", bytes: 4_194_304 };

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const probeOf = (answer: string | null): MediaSupportProbe => () => answer;

/** Enough of an HTMLMediaElement for the one-player floor. */
function fakeElement(paused = false) {
  const element = { paused, pauses: 0, pause() { this.paused = true; this.pauses++; } };
  return element as unknown as HTMLMediaElement & { pauses: number };
}

beforeEach(() => {
  const current = __playingMediaForTests();
  if (current) releaseMediaPlayback(current);
});

describe("whether this computer can play these bytes", () => {
  it("believes canPlayType, in both directions", () => {
    expect(canPlayMedia("audio", "audio/wav", probeOf("probably"))).toBe("probably");
    expect(canPlayMedia("audio", "audio/mpeg", probeOf("maybe"))).toBe("maybe");
    expect(canPlayMedia("video", "video/mp4", probeOf(""))).toBe("no");
  });

  it("says unknown where there is nothing to ask, and lets the element answer for itself", () => {
    expect(canPlayMedia("audio", "audio/wav", probeOf(null))).toBe("unknown");
    expect(canPlayMedia("audio", "audio/wav", () => { throw new Error("no element"); })).toBe("unknown");
    // no DOM in this suite: the real probe is the one the app uses
    expect(canPlayMedia("audio", "audio/wav")).toBe("unknown");
  });

  it("never offers a player for anything that is not audio or video", () => {
    expect(canPlayMedia("image", "image/png", probeOf("probably"))).toBe("no");
    expect(canPlayMedia("file", "application/octet-stream", probeOf("probably"))).toBe("no");
  });
});

describe("saying why, rather than going quiet", () => {
  it("maps every MediaError code to its own sentence", () => {
    const messages = [1, 2, 3, 4].map(mediaErrorMessage);
    expect(new Set(messages).size).toBe(4);
    for (const message of messages) expect(message.length).toBeGreaterThan(10);
    expect(mediaErrorMessage(3)).toMatch(/decoded/i);
    expect(mediaErrorMessage(2)).toMatch(/could not be read/i);
  });

  it("still says something when there is no code at all", () => {
    for (const code of [null, undefined, 0, 99]) expect(mediaErrorMessage(code as number).length).toBeGreaterThan(10);
  });

  it("repeats the harness's reason without inventing a cause", () => {
    expect(unplayableMessage("missing")).toMatch(/no longer/i);
    expect(unplayableMessage("changed")).toMatch(/changed/i);
    expect(unplayableMessage("denied")).toMatch(/not available/i);
    expect(unplayableMessage("unsupported")).toMatch(/no player/i);
    expect(new Set((["missing", "changed", "denied", "unsupported"] as const).map(unplayableMessage)).size).toBe(4);
  });

  it("names where the bytes came from", () => {
    expect(mediaSourceLabel("workspace")).toMatch(/workspace/i);
    expect(new Set((["workspace", "artifact", "attachment", "screen-frame", "external-link"] as const).map(mediaSourceLabel)).size).toBe(5);
  });
});

describe("size and duration a person reads", () => {
  it("formats bytes at the scale they were reported", () => {
    expect(formatMediaBytes(0)).toBe("0 bytes");
    expect(formatMediaBytes(900)).toBe("900 bytes");
    expect(formatMediaBytes(90_044)).toBe("88 KB");
    expect(formatMediaBytes(4_194_304)).toBe("4.0 MB");
    expect(formatMediaBytes(21 * 1024 * 1024)).toBe("21 MB");
    expect(formatMediaBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  it("shows nothing rather than a wrong size or duration", () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(formatMediaBytes(value as number)).toBeNull();
      expect(formatMediaDuration(value as number)).toBeNull();
    }
  });

  it("formats durations as clocks", () => {
    expect(formatMediaDuration(0)).toBe("0:00");
    expect(formatMediaDuration(7.4)).toBe("0:07");
    expect(formatMediaDuration(243)).toBe("4:03");
    expect(formatMediaDuration(3723)).toBe("1:02:03");
  });
});

describe("one player at a time", () => {
  it("pauses the card that was playing when another starts", () => {
    const first = fakeElement(), second = fakeElement();
    expect(claimMediaPlayback(first)).toBeNull();
    expect(claimMediaPlayback(second)).toBe(first);
    expect(first.paused).toBe(true);
    expect(first.pauses).toBe(1);
    expect(__playingMediaForTests()).toBe(second);
  });

  it("does not pause the same element it just claimed, or one already paused", () => {
    const element = fakeElement();
    claimMediaPlayback(element);
    expect(claimMediaPlayback(element)).toBeNull();
    expect(element.pauses).toBe(0);
    const paused = fakeElement(true), next = fakeElement();
    claimMediaPlayback(paused);
    claimMediaPlayback(next);
    expect(paused.pauses).toBe(0);
  });

  it("survives an element that is already gone from the document", () => {
    const gone = { get paused() { return false; }, pause() { throw new Error("detached"); } } as unknown as HTMLMediaElement;
    claimMediaPlayback(gone);
    expect(() => claimMediaPlayback(fakeElement())).not.toThrow();
  });

  it("frees the floor on pause, on ending and on unmount", () => {
    const element = fakeElement();
    claimMediaPlayback(element);
    releaseMediaPlayback(element);
    expect(__playingMediaForTests()).toBeNull();
    // releasing a card that never had the floor leaves the current one alone
    const other = fakeElement();
    claimMediaPlayback(other);
    releaseMediaPlayback(element);
    expect(__playingMediaForTests()).toBe(other);
  });
});

describe("asking the harness again before giving up", () => {
  const now = 1_700_000_000_000;
  const live = { url: URL_WITH_CAP, expiresAt: now + 600_000 };
  const spent = { url: URL_WITH_CAP, expiresAt: now - 1 };

  it("treats a capability as expired a little before the harness does", () => {
    expect(mediaSourceExpired(live, now)).toBe(false);
    expect(mediaSourceExpired({ url: URL_WITH_CAP, expiresAt: now + MEDIA_EXPIRY_MARGIN_MS + 1 }, now)).toBe(false);
    expect(mediaSourceExpired({ url: URL_WITH_CAP, expiresAt: now + MEDIA_EXPIRY_MARGIN_MS }, now)).toBe(true);
    expect(mediaSourceExpired(spent, now)).toBe(true);
    // no expiry known: never assumed expired
    expect(mediaSourceExpired({ url: URL_WITH_CAP }, now)).toBe(false);
  });

  it("refreshes once for a failure the clock explains, whatever code the browser chose", () => {
    // Chromium reports a 403 as SRC_NOT_SUPPORTED (4), the codec failure code
    for (const code of [2, 4, null, undefined, 0]) expect(shouldRefreshMediaSource(code, spent, false, now), String(code)).toBe(true);
    for (const code of [2, 4, null, undefined]) expect(shouldRefreshMediaSource(code, spent, true, now), String(code)).toBe(false);
  });

  it("refreshes once for a network failure even while the capability looks live", () => {
    expect(shouldRefreshMediaSource(2, live, false, now)).toBe(true);
    expect(shouldRefreshMediaSource(2, live, true, now)).toBe(false);
  });

  it("never refreshes for a real codec or decode failure, or an abort", () => {
    expect(shouldRefreshMediaSource(4, live, false, now)).toBe(false);
    for (const source of [live, spent]) {
      expect(shouldRefreshMediaSource(3, source, false, now)).toBe(false);
      expect(shouldRefreshMediaSource(1, source, false, now)).toBe(false);
    }
  });
});

describe("the card itself", () => {
  it("renders controls with no autoplay and only metadata preloaded", () => {
    const html = render(createElement(MediaPlayerCard, { asset: audioAsset, url: URL_WITH_CAP, probe: probeOf("probably") }));
    expect(html).toContain("<audio");
    expect(html).toContain('preload="metadata"');
    expect(html).toContain("controls=\"\"");
    expect(html).not.toMatch(/autoplay/i);
    expect(html).not.toMatch(/\bloop\b/);
    expect(html).toContain("take-2.wav");
    expect(html).toContain("88 KB");
  });

  it("renders video inline rather than taking over the screen", () => {
    const html = render(createElement(MediaPlayerCard, { asset: videoAsset, url: URL_WITH_CAP, probe: probeOf("maybe") }));
    expect(html).toContain("<video");
    expect(html).toMatch(/playsinline/i);
    expect(html).not.toMatch(/autoplay/i);
    expect(html).toContain("demo.webm");
  });

  it("offers exactly the bytes on screen for download, with no referrer", () => {
    const html = render(createElement(MediaPlayerCard, { asset: audioAsset, url: URL_WITH_CAP, probe: probeOf("probably") }));
    expect(html).toContain(`href="${URL_WITH_CAP.replace(/&/g, "&amp;")}"`);
    expect(html).toContain('download="take-2.wav"');
    expect(html).toMatch(/referrerpolicy="no-referrer"/i);
  });

  it("does not offer a download the harness did not grant", () => {
    const asset = { ...audioAsset, capabilities: { ...audioAsset.capabilities, download: false } };
    const html = render(createElement(MediaPlayerCard, { asset, url: URL_WITH_CAP, probe: probeOf("probably") }));
    expect(html).not.toContain("download=");
  });

  it("replaces the player with a reason when this computer has no codec for it", () => {
    const html = render(createElement(MediaPlayerCard, { asset: videoAsset, url: URL_WITH_CAP, probe: probeOf("") }));
    expect(html).not.toContain("<video");
    expect(html).toContain('data-media-player-state="unplayable"');
    expect(html).toMatch(/cannot play this format/i);
    // the file is still reachable: a dead card would be worse than none
    expect(html).toContain('download="demo.webm"');
  });

  it("shows an unplayable file's name and reason without any byte URL", () => {
    const html = render(createElement(MediaUnplayableCard, { asset: { ...audioAsset, availability: "missing" }, reason: unplayableMessage("missing") }));
    expect(html).toContain("take-2.wav");
    expect(html).toMatch(/no longer/i);
    expect(html).not.toContain("/api/media/bytes/");
  });
});

describe("a path in a transcript", () => {
  const scope = { botId: "research", threadId: "task-7" };
  const fallback = createElement("span", { "data-testid": "fallback" }, "take-2.wav");
  const never = (async () => new Promise(() => {})) as never;

  it("shows the caller's own affordance until the harness has answered", () => {
    const html = render(createElement(LocalMedia, { scope, path: "/desk/outputs/take-2.wav", fallback, resolve: never }));
    expect(html).toBe('<span data-testid="fallback">take-2.wav</span>');
  });

  // The ask/do-not-ask decision is the pure `localMediaRequestFor`; the
  // surface's effect asks exactly when it is non-null (effects do not run
  // under static rendering, so the rule is pinned here, not through a spy).
  it("asks about a U-28 container in a bubble that knows its conversation, and about nothing else", () => {
    expect(localMediaRequestFor(scope, "/desk/outputs/take-2.wav")).toEqual({ scope, absolutePath: "/desk/outputs/take-2.wav" });
    for (const name of ["song.mp3", "clip.ogg", "voice.oga", "note.m4a", "demo.mp4", "demo.webm"]) {
      expect(localMediaRequestFor(scope, `/desk/outputs/${name}`)).not.toBeNull();
    }
    // Only the conversation identity travels: extra scope fields are dropped.
    expect(localMediaRequestFor({ ...scope, serverId: "local" } as never, "/desk/outputs/take-2.wav")).toEqual({ scope, absolutePath: "/desk/outputs/take-2.wav" });
  });

  it("does not even ask about a file type it has no player for", () => {
    for (const name of ["notes.txt", "clip.mov", "song.flac", "film.mkv", "old.avi", "clip.m4v", "stream.m3u8", "take-2.wav.exe", "take-2"]) {
      expect(localMediaRequestFor(scope, `/desk/outputs/${name}`)).toBeNull();
    }
    const html = render(createElement(LocalMedia, { scope, path: "/desk/outputs/notes.txt", fallback, resolve: never }));
    expect(html).toBe('<span data-testid="fallback">take-2.wav</span>');
  });

  it("does not ask when the bubble does not know its own conversation", () => {
    expect(localMediaRequestFor(undefined, "/desk/outputs/take-2.wav")).toBeNull();
    const html = render(createElement(LocalMedia, { scope: undefined, path: "/desk/outputs/take-2.wav", fallback, resolve: never }));
    expect(html).toBe('<span data-testid="fallback">take-2.wav</span>');
  });
});
