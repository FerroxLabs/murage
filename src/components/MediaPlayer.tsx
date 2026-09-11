// Audio and video cards in chat (0.1.52 M3, F5-T3). A file a bot produced or
// a person attached becomes a real player only after the harness has proved
// three things (src/lib/media-resolve.ts): the conversation has a dedicated
// workspace, the file is a regular file inside it right now, and the bytes
// are a type this build streams. The player then reads those bytes through
// the authorized byte route (F5-T1), never through a path.
//
// What this component refuses to do:
// - Autoplay. `preload="metadata"` fetches a header for the duration and
//   stops; nothing makes a sound until the person presses play.
// - Keep playing after it leaves the screen. Unmounting — closing a thread,
//   scrolling a virtualised transcript, switching a room — pauses the element
//   and drops its source so the stream is released, not merely muted.
// - Let two cards talk over each other. Pressing play anywhere pauses the
//   card that was playing. Only Murage's own players are touched: another
//   app's music keeps going.
// - Claim a codec it does not have. `canPlayType` decides before the element
//   is rendered and the element's own error decides afterwards; either way
//   the card says plainly that this file cannot be played here and keeps the
//   Save a copy action. Nothing is transcoded and nothing is fetched from
//   anywhere but this harness.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Download, FileAudio, FileVideo } from "lucide-react";

import { mediaHintForPath } from "@/lib/composer-attachments";
import { forgetLocalMedia, localMedia, type LocalMediaRequest, type LocalMediaResolution, type MediaApi, type MediaUnplayableReason } from "@/lib/media-resolve";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api as defaultApi } from "@/state/store";
import type { MediaAsset, MediaAssetKind, MediaAssetSource } from "../../shared/media-assets";
import type { WorkspaceScopeRef } from "../../shared/workspace-files";

// ── Truthful support and failure ─────────────────────────────────────────

export type MediaSupport = "probably" | "maybe" | "no" | "unknown";
/** `canPlayType`, or null where there is no DOM to ask (the node test suite
 * and server rendering). "Unknown" is not "yes": it only means the element is
 * rendered and allowed to answer for itself. */
export type MediaSupportProbe = (kind: "audio" | "video", mime: string) => string | null;

const domProbe: MediaSupportProbe = (kind, mime) => {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const element = document.createElement(kind) as HTMLMediaElement;
  return typeof element.canPlayType === "function" ? element.canPlayType(mime) : null;
};

export function canPlayMedia(kind: MediaAssetKind, mime: string, probe: MediaSupportProbe = domProbe): MediaSupport {
  if (kind !== "audio" && kind !== "video") return "no";
  let answer: string | null;
  try { answer = probe(kind, mime); } catch { return "unknown"; }
  if (answer === null || answer === undefined) return "unknown";
  if (answer === "probably" || answer === "maybe") return answer;
  return "no";
}

/** What an HTMLMediaElement's error actually was. The numbers are the
 * MediaError constants; they are read defensively because a card must never
 * turn a decode failure into silence. */
export function mediaErrorMessage(code: number | null | undefined): string {
  switch (code) {
    case 1: return t("media.player.errorAborted");
    case 2: return t("media.player.errorNetwork");
    case 3: return t("media.player.errorDecode");
    case 4: return t("media.player.errorFormat");
    default: return t("media.player.errorUnknown");
  }
}

export function unplayableMessage(reason: MediaUnplayableReason): string {
  switch (reason) {
    case "missing": return t("media.player.missing");
    case "changed": return t("media.player.changed");
    case "denied": return t("media.player.denied");
    case "unsupported": return t("media.player.unsupportedType");
  }
}

export function mediaSourceLabel(source: MediaAssetSource): string {
  switch (source) {
    case "workspace": return t("media.source.workspace");
    case "artifact": return t("media.source.artifact");
    case "attachment": return t("media.source.attachment");
    case "screen-frame": return t("media.source.screenFrame");
    case "external-link": return t("media.source.external");
  }
}

// ── Formatting ───────────────────────────────────────────────────────────

const UNITS = ["bytes", "KB", "MB", "GB"] as const;

/** A size a person reads, or null when the harness did not report one. */
export function formatMediaBytes(bytes: number | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit++; }
  const rounded = unit === 0 ? String(Math.round(value)) : value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${UNITS[unit]}`;
}

/** "0:07", "4:03", "1:02:03" — or null while the duration is unknown, which
 * is the honest state before metadata has loaded and for a live stream. */
export function formatMediaDuration(seconds: number | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.floor(seconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor(whole / 60) % 60, hours = Math.floor(whole / 3600);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

// ── One sound at a time ──────────────────────────────────────────────────
//
// Module state on purpose: the rule is "one Murage player", not "one per
// transcript", and two surfaces (a room and a chat, a card and the Files
// preview) must not each keep their own idea of what is playing.

let playing: HTMLMediaElement | null = null;

/** Take the floor. Returns the element that was paused, for tests. */
export function claimMediaPlayback(element: HTMLMediaElement): HTMLMediaElement | null {
  const previous = playing;
  playing = element;
  if (!previous || previous === element) return null;
  try { if (!previous.paused) previous.pause(); } catch { /* already gone */ }
  return previous;
}

/** Give it up — on pause, on ending, and on unmount. */
export function releaseMediaPlayback(element: HTMLMediaElement): void {
  if (playing === element) playing = null;
}

export function __playingMediaForTests(): HTMLMediaElement | null { return playing; }

// ── Cards ────────────────────────────────────────────────────────────────

const CARD = "my-1 flex max-w-full flex-col gap-1.5 rounded-lg border border-hairline/40 bg-inset/70 px-2.5 py-2 align-top text-[12px] text-ink-secondary";
const ACTION = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-accent underline decoration-accent/40 hover:decoration-accent focus-visible:outline-2 focus-visible:outline-focus";

function MediaHeader({ asset, duration }: { asset: MediaAsset; duration: number | undefined }) {
  const meta = [mediaSourceLabel(asset.source), formatMediaBytes(asset.bytes), formatMediaDuration(duration)].filter(Boolean) as string[];
  const Icon = asset.kind === "video" ? FileVideo : FileAudio;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon size={13} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-ink" title={asset.name}>{asset.name}</span>
      <span className="shrink-0 text-[11px] text-ink-secondary/80">{meta.join(" · ")}</span>
    </span>
  );
}

function DownloadAction({ asset, url, onClick }: { asset: MediaAsset; url: string; onClick?: (event: { preventDefault: () => void }) => void }) {
  if (!asset.capabilities.download) return null;
  return (
    <a href={url} download={asset.name} referrerPolicy="no-referrer" className={ACTION} title={t("media.player.downloadTitle")} onClick={onClick}>
      <Download size={12} aria-hidden="true" />
      {t("media.player.download")}
    </a>
  );
}

/** The card a person sees when the bytes exist but this computer will not
 * play them: no silent empty box, and the file is still reachable. */
export function MediaUnplayableCard({ asset, url, reason, className, onDownload }: {
  asset: MediaAsset;
  url?: string;
  reason: string;
  className?: string;
  /** The player's renew-on-click: a card shown after the capability stopped
   * working must not hand out the very link the harness now refuses. */
  onDownload?: (event: { preventDefault: () => void }) => void;
}) {
  return (
    <span className={cn(CARD, className)} data-media-player={asset.kind} data-media-player-state="unplayable">
      <MediaHeader asset={asset} duration={asset.durationSeconds} />
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <AlertTriangle size={12} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0">{reason}</span>
        {url && <DownloadAction asset={asset} url={url} onClick={onDownload} />}
      </span>
    </span>
  );
}

/** A byte URL and when the capability inside it stops working. */
export interface MediaSource { url: string; expiresAt?: number }
/** Ask the harness for a fresh capability for the same pinned file. Resolves
 * null when the file is no longer this conversation's playable file, in which
 * case the caller has already moved to a truthful non-player state. */
export type MediaSourceRefresh = () => Promise<MediaSource | null>;

/** A capability this close to its expiry is treated as expired: a range
 * request sent now would arrive after the harness stopped honouring it. */
export const MEDIA_EXPIRY_MARGIN_MS = 15_000;

export function mediaSourceExpired(source: MediaSource, now = Date.now()): boolean {
  return typeof source.expiresAt === "number" && now >= source.expiresAt - MEDIA_EXPIRY_MARGIN_MS;
}

/** Whether an element failure is worth one more ask of the harness before
 * the card gives up. A capability lives ten minutes (MEDIA_CAPABILITY_TTL_MS)
 * and a transcript stays open for hours, so a seek after that answers 403 —
 * which Chromium reports as MEDIA_ERR_SRC_NOT_SUPPORTED (4), the same code a
 * real codec failure gets. The clock, not the code, tells them apart; a
 * network failure (2) gets one retry regardless, because the harness may
 * have restarted (which revokes every URL it issued). An abort (1) is the
 * person's or the card's own doing and a decode failure (3) is the bytes'. */
export function shouldRefreshMediaSource(code: number | null | undefined, source: MediaSource, alreadyRefreshed: boolean, now = Date.now()): boolean {
  if (alreadyRefreshed) return false;
  if (code === 1 || code === 3) return false;
  return code === 2 || mediaSourceExpired(source, now);
}

/** The player itself. `url` is the capability URL the resolver returned; it
 * is never derived here and never logged. */
export function MediaPlayerCard({ asset, url, expiresAt, refresh, className, probe }: {
  asset: MediaAsset;
  url: string;
  expiresAt?: number;
  /** Given by a surface that can ask the harness again (LocalMedia). Without
   * it an expired capability is a failure the card reports. */
  refresh?: MediaSourceRefresh;
  className?: string;
  /** Test seam for `canPlayType`. */
  probe?: MediaSupportProbe;
}) {
  const elementRef = useRef<HTMLMediaElement | null>(null);
  const [support] = useState<MediaSupport>(() => canPlayMedia(asset.kind, asset.mime, probe ?? domProbe));
  const [failure, setFailure] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | undefined>(asset.durationSeconds);
  // The source in use. It starts as the props and moves on only when a
  // refresh succeeds; a parent that re-renders with the same URL changes
  // nothing, so playback is never interrupted by a transcript re-render.
  const [source, setSource] = useState<MediaSource>({ url, ...(expiresAt !== undefined ? { expiresAt } : {}) });
  // Where playback was when the old capability failed, so the fresh source
  // continues from there instead of from the start.
  const resume = useRef<{ at: number; playing: boolean } | null>(null);
  // One automatic refresh per failure; a successful play resets it.
  const refreshed = useRef(false);
  const refreshing = useRef<Promise<MediaSource | null> | null>(null);

  // Capture the element at mount: React may have detached the ref by the time
  // a deletion's cleanup runs, and a player that outlives its card is exactly
  // the bug this guards against.
  //
  // The effect body re-attaches the source it may have taken away. React sets
  // `src` while rendering, so it does not put it back when an effect runs a
  // second time — and effects DO run twice under StrictMode, which the dev
  // server, src/main.tsx and the e2e rig all use. Without this the cleanup
  // silently emptied every player in development.
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (element.getAttribute("src") !== source.url) {
      element.setAttribute("src", source.url);
      try { element.load(); } catch { /* not attached yet */ }
    }
    return () => {
      try { element.pause(); } catch { /* detached already */ }
      releaseMediaPlayback(element);
      // Dropping the source aborts the byte stream instead of leaving it
      // buffering into a card nobody can see.
      element.removeAttribute("src");
      try { element.load(); } catch { /* nothing left to load */ }
    };
  }, [source.url]);

  /** Ask once, share the answer between a failing element and a download
   * click that land in the same moment. */
  const askAgain = (): Promise<MediaSource | null> => {
    if (!refresh) return Promise.resolve(null);
    if (!refreshing.current) {
      refreshing.current = refresh().catch((): MediaSource | null => null).finally(() => { refreshing.current = null; });
    }
    return refreshing.current;
  };

  const onDownload = (event: { preventDefault: () => void }) => {
    if (!refresh || !mediaSourceExpired(source)) return;
    // The link in the page carries a capability the harness would refuse.
    // Fetch a fresh one and save through it; the person clicked once.
    event.preventDefault();
    void askAgain().then(next => {
      if (!next) return;
      setSource(next);
      if (typeof document === "undefined") return;
      const anchor = document.createElement("a");
      anchor.href = next.url;
      anchor.download = asset.name;
      anchor.referrerPolicy = "no-referrer";
      anchor.click();
    });
  };

  // Every "Save a copy" this card shows — beside the player, on the
  // cannot-play card, and after a failure — renews the same way.
  if (support === "no") {
    return <MediaUnplayableCard asset={asset} url={source.url} reason={t("media.player.unsupportedHere")} className={className} onDownload={onDownload} />;
  }
  if (failure) {
    return <MediaUnplayableCard asset={asset} url={source.url} reason={failure} className={className} onDownload={onDownload} />;
  }

  const shared = {
    ref: (element: HTMLMediaElement | null) => { elementRef.current = element; },
    src: source.url,
    controls: true,
    preload: "metadata" as const,
    // Belt and braces: the attribute is absent by default, and this makes a
    // future copy of this markup unable to add it by accident.
    autoPlay: false,
    "data-testid": `media-player-${asset.kind}`,
    "aria-label": asset.kind === "video" ? t("media.player.videoLabel", { name: asset.name }) : t("media.player.audioLabel", { name: asset.name }),
    onPlay: (event: { currentTarget: HTMLMediaElement }) => claimMediaPlayback(event.currentTarget),
    onPlaying: () => { refreshed.current = false; },
    onPause: (event: { currentTarget: HTMLMediaElement }) => releaseMediaPlayback(event.currentTarget),
    onEnded: (event: { currentTarget: HTMLMediaElement }) => releaseMediaPlayback(event.currentTarget),
    onLoadedMetadata: (event: { currentTarget: HTMLMediaElement }) => {
      const element = event.currentTarget, value = element.duration;
      if (Number.isFinite(value) && value > 0) setDuration(value);
      const pending = resume.current;
      if (!pending) return;
      resume.current = null;
      if (pending.at > 0 && Number.isFinite(value) && pending.at < value) element.currentTime = pending.at;
      // Continuing what the person already started is not autoplay: the
      // element only moved to a fresh URL for the same bytes.
      if (pending.playing) element.play().catch(() => undefined);
    },
    onError: (event: { currentTarget: HTMLMediaElement }) => {
      const element = event.currentTarget, code = element.error?.code;
      releaseMediaPlayback(element);
      if (!refresh || !shouldRefreshMediaSource(code, source, refreshed.current)) {
        setFailure(mediaErrorMessage(code));
        return;
      }
      refreshed.current = true;
      const at = Number.isFinite(element.currentTime) ? element.currentTime : 0;
      const playing = !element.paused && !element.ended;
      void askAgain().then(next => {
        // The card may have been unmounted meanwhile; the effect cleanup has
        // already released the element, and a state update would be ignored.
        if (elementRef.current !== element) return;
        if (!next) { setFailure(mediaErrorMessage(code)); return; }
        resume.current = { at, playing };
        setSource(next);
      });
    },
  };

  return (
    <span className={cn(CARD, className)} data-media-player={asset.kind} data-media-player-state="ready">
      <MediaHeader asset={asset} duration={duration} />
      {asset.kind === "video"
        ? <video {...shared} playsInline className="block max-h-80 w-full rounded bg-black/60" />
        : <audio {...shared} className="block w-full" />}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <DownloadAction asset={asset} url={source.url} onClick={onDownload} />
      </span>
    </span>
  );
}

// ── The transcript surface ───────────────────────────────────────────────

/** The one gate before the harness is asked anything: a suffix from the U-28
 * hint table AND a bubble that knows its own conversation. Anything else is
 * the caller's fallback with no request at all. Pure, so the rule is testable
 * without a DOM; LocalMedia's effect asks exactly when this is non-null. */
export function localMediaRequestFor(scope: WorkspaceScopeRef | undefined, path: string): LocalMediaRequest | null {
  if (!mediaHintForPath(path) || !scope) return null;
  return { scope: { botId: scope.botId, threadId: scope.threadId }, absolutePath: path };
}

/** A path a transcript carried. Renders `fallback` — the caller's existing,
 * already safe affordance — unless and until the harness proves the file is
 * this conversation's and playable. The path itself is never used as a URL,
 * so a failure here is silent by design: the person keeps the chip or the
 * Save a copy link they had before. */
export function LocalMedia({ scope, path, fallback, api = defaultApi, resolve = localMedia }: {
  scope: WorkspaceScopeRef | undefined;
  path: string;
  fallback: ReactNode;
  api?: MediaApi;
  resolve?: typeof localMedia;
}) {
  const [resolution, setResolution] = useState<LocalMediaResolution | null>(null);
  const eligible = localMediaRequestFor(scope, path) !== null;
  const botId = scope?.botId, threadId = scope?.threadId;
  // The latest request this surface is showing; a refresh that lands after
  // the path or conversation changed must not overwrite the newer answer.
  const current = useRef<LocalMediaRequest | null>(null);

  useEffect(() => {
    const request = localMediaRequestFor(botId === undefined || threadId === undefined ? undefined : { botId, threadId }, path);
    if (!request) { current.current = null; return; }
    current.current = request;
    let alive = true;
    setResolution(null);
    void resolve(request, api).then(value => { if (alive) setResolution(value); });
    return () => { alive = false; };
  }, [botId, threadId, path, api, resolve]);

  // The card asks for this when its capability stopped working: the same
  // three questions again, with the cached answer dropped first. A file that
  // has since changed or gone comes back as its truthful non-player state.
  const refresh = useCallback(async (): Promise<MediaSource | null> => {
    const request = current.current;
    if (!request) return null;
    forgetLocalMedia(request);
    const next = await resolve(request, api);
    if (current.current !== request) return null;
    if (next.state === "ready") return { url: next.url, ...(next.expiresAt !== undefined ? { expiresAt: next.expiresAt } : {}) };
    setResolution(next);
    return null;
  }, [api, resolve]);

  if (!eligible || !resolution || resolution.state === "unavailable") return <>{fallback}</>;
  if (resolution.state === "unplayable") {
    // The bytes are not coming, so the caller's own action is the one that
    // still works. Say why rather than replacing it with a dead player.
    return (
      <>
        {fallback}
        <span className="ml-1.5 text-[11.5px] text-ink-secondary" data-media-player-state="unplayable">
          {unplayableMessage(resolution.reason)}
        </span>
      </>
    );
  }
  // Keyed by pinned identity: a re-resolve after a change starts a fresh
  // element rather than inheriting the old one's failure or position.
  return (
    <MediaPlayerCard
      key={`${resolution.asset.id}:${resolution.asset.revision ?? ""}`}
      asset={resolution.asset}
      url={resolution.url}
      expiresAt={resolution.expiresAt}
      refresh={refresh}
    />
  );
}
