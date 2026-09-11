// One image surface for chat content (0.1.52 M2, F5-T2). Attachment galleries,
// Markdown images, the bot's screen frames, room transcripts and the Files
// saved-copy preview all render their inline image through ImageThumb and
// enlarge it in the same ImageLightbox, so keyboard access, focus handling,
// failure states and reduced motion are decided once.
//
// What this component will not do:
// - Resolve a path. Callers hand it an already authorized source: a
//   same-origin attachment URL the server generated, a saved copy's pinned
//   bytes, or a screen frame the bot already delivered. A path, file:// URL
//   or relative link written in Markdown is shown as text, not fetched.
// - Load a remote image by itself. An external Markdown image is a card until
//   the person asks for it, and even then it is fetched with no referrer.
// - Capture anything. Enlarging a screen frame shows the exact bytes already
//   in the transcript; it never asks for a new frame or runs a tool.
//
// The dialog is a native modal <dialog>, not a positioned <div>: the Files
// browser is itself a modal <dialog>, and only another top-layer dialog can sit
// above it without being made inert.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ImageOff, Maximize2, X } from "lucide-react";

import { attachmentImageUrl } from "@/lib/composer-attachments";
import { artifactReferenceSource, attachmentReferenceSource } from "@/lib/image-reference";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { ImageReferenceSource, MediaAssetSource } from "../../shared/media-assets";
import type { Artifact } from "../../shared/artifacts";
import { UseAsReferenceButton } from "./UseAsReferenceButton";

/** Where an enlarged image came from. `MediaAssetSource` from the frozen media
 * contract, plus `inline-data`: raster bytes embedded in the message text
 * itself, which exist nowhere else and are therefore not an asset. */
export type ImageMediaSource = Extract<MediaAssetSource, "attachment" | "artifact" | "screen-frame" | "external-link"> | "inline-data";

export interface ImageMediaItem {
  /** Identity inside the set being shown. Load, failure and focus state reset
   * when it changes, so image B never inherits image A's failure. */
  id: string;
  /** An already authorized source: a same-origin URL or already delivered
   * bytes. Never a filesystem path. */
  src: string;
  /** Filename or label shown in the dialog header. */
  name: string;
  alt: string;
  source: ImageMediaSource;
  /** Offer Download of exactly `src`, the bytes on screen. */
  download: boolean;
  /** IMG-SEED (F5-T4): how the harness would pin *these* bytes as a reference
   * image. Present only for a source the harness can re-read by identity (a
   * conversation attachment, a saved Files version). Absent means the action
   * is not offered at all: a screen frame, an external URL or bytes that exist
   * only inside the message text are never silently promoted. */
  reference?: ImageReferenceAction;
}

/** The frozen reference source plus, when the caller knows it, the
 * conversation the image belongs to. Without a conversation the action goes
 * to the composer on screen, and the harness refuses unless that conversation
 * really holds the image. */
export interface ImageReferenceAction { source: ImageReferenceSource; threadId?: string; botId?: string }

/** Rasters only: an SVG is active content and is never shown inline. */
const RASTER_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const RASTER_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isRasterDataUrl(value: string | undefined): boolean {
  return typeof value === "string" && RASTER_DATA_URL.test(value);
}

export function imageSourceLabel(source: ImageMediaSource): string {
  switch (source) {
    case "attachment": return t("media.source.attachment");
    case "artifact": return t("media.source.artifact");
    case "screen-frame": return t("media.source.screenFrame");
    case "external-link": return t("media.source.external");
    case "inline-data": return t("media.source.inline");
  }
}

/** Keyboard navigation inside the lightbox set. Returns the next index, or
 * null when the key is not a navigation key or there is nowhere to go. */
export function nextLightboxIndex(index: number, count: number, key: string): number | null {
  if (count < 2) return null;
  switch (key) {
    case "ArrowRight": return (index + 1) % count;
    case "ArrowLeft": return (index - 1 + count) % count;
    case "Home": return index === 0 ? null : 0;
    case "End": return index === count - 1 ? null : count - 1;
    default: return null;
  }
}

// ── Item builders: the only ways a source becomes something this renders ──

/** A transcript attachment path. Only a name the attachment server itself
 * generates becomes a same-origin URL (see attachmentImageUrl). */
export function attachmentImageItem(path: string, name: string, index = 0): ImageMediaItem | null {
  const src = attachmentImageUrl(path);
  if (!src) return null;
  // The same path that made the URL decides the reference id, so the harness
  // re-reads the very attachment shown here.
  const source = attachmentReferenceSource(path);
  return { id: `attachment:${src}#${index}`, src, name, alt: name, source: "attachment", download: true, ...(source ? { reference: { source } } : {}) };
}

/** The saved copy's pinned bytes, as the Files preview route returned them. */
export function artifactImageItem(artifact: ArtifactImage, content: string | undefined): ImageMediaItem | null {
  if (!content || !isRasterDataUrl(content)) return null;
  // Pinned to this exact saved version: a later version of the same file is a
  // different reference, and the harness refuses a digest that moved.
  const source = artifactReferenceSource(artifact);
  return {
    id: `artifact:${artifact.id}:${artifact.sha256}`, src: content, name: artifact.name, alt: artifact.name, source: "artifact", download: true,
    ...(source && artifact.threadId ? { reference: { source, threadId: artifact.threadId, ...(artifact.botId ? { botId: artifact.botId } : {}) } } : {}),
  };
}

/** A saved file as the Files preview knows it. The reference action needs the
 * pinned digest, its type and size, and the conversation that owns it. */
export type ArtifactImage = Pick<Artifact, "id" | "name" | "sha256"> & Partial<Pick<Artifact, "mime" | "bytes" | "threadId" | "botId">>;

/** A frame the bot's screen stream already delivered. Not saved anywhere, so
 * there is no Download: keeping a copy of a screen is a separate, explicit act. */
export function screenFrameItem(png: string, mime?: string): ImageMediaItem {
  const type = mime && RASTER_MIMES.has(mime.toLowerCase()) ? mime.toLowerCase() : "image/png";
  const name = t("media.screenFrame.name");
  return {
    id: `screen-frame:${type}:${png.length}:${png.slice(0, 32)}:${png.slice(-32)}`,
    src: `data:${type};base64,${png}`,
    name,
    alt: name,
    source: "screen-frame",
    download: false,
  };
}

export type MarkdownImageResolution =
  | { kind: "inline"; item: ImageMediaItem }
  | { kind: "external"; url: string; host: string; alt: string }
  | { kind: "local"; alt: string };

/** What a Markdown image may become. Filename or extension alone never
 * authorizes a load: only the attachment server's own URL form and bytes
 * already inside the message render inline; http(s) waits for a click; every
 * other shape (absolute or relative paths, file://, blob:, SVG) stays text. */
export function resolveMarkdownImage(src: string | undefined, alt: string | undefined): MarkdownImageResolution {
  const label = (alt ?? "").trim();
  const name = label || t("media.image.untitled");
  const value = (src ?? "").trim();
  if (isRasterDataUrl(value)) {
    return { kind: "inline", item: { id: `inline:${value.length}:${value.slice(-32)}`, src: value, name, alt: label, source: "inline-data", download: true } };
  }
  if (value.startsWith("/api/attachments/") && attachmentImageUrl(value) === value) {
    return { kind: "inline", item: { id: `attachment:${value}`, src: value, name, alt: label, source: "attachment", download: true } };
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return { kind: "external", url: url.href, host: url.host, alt: label };
    } catch {
      return { kind: "local", alt: label };
    }
  }
  return { kind: "local", alt: label };
}

// ── Inline thumbnail ─────────────────────────────────────────────────────

export function ImageThumb({ item, label, onOpen, className, imgClassName }: {
  item: ImageMediaItem;
  label: string;
  onOpen: () => void;
  className?: string;
  imgClassName?: string;
}) {
  // callers key this by item.id, so a new image starts unfailed
  const [failed, setFailed] = useState(false);
  if (failed) {
    // stays visible: a missing image says so instead of silently vanishing
    return (
      <span
        role="img"
        aria-label={t("media.thumb.unavailable", { name: item.name })}
        data-image-media-state="unavailable"
        className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-hairline/40 bg-inset/70 px-2.5 py-1.5 align-top text-[12px] text-ink-secondary"
      >
        <ImageOff size={13} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{t("media.thumb.unavailable", { name: item.name })}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
      data-image-media={item.source}
      className={cn(
        "group/image relative inline-block max-w-full overflow-hidden text-left align-top focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        className,
      )}
    >
      <img
        src={item.src}
        alt={item.alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn(
          "block max-w-full transition-transform duration-200 group-hover/image:scale-[1.015] motion-reduce:transition-none motion-reduce:group-hover/image:scale-100",
          imgClassName,
        )}
      />
      <span
        aria-hidden="true"
        className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100 motion-reduce:transition-none"
      >
        <Maximize2 size={13} />
      </span>
    </button>
  );
}

/** One image with its own lightbox. */
export function ImageMedia({ item, label, className, imgClassName }: {
  item: ImageMediaItem;
  label?: string;
  className?: string;
  imgClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const items = useMemo(() => [item], [item]);
  return (
    <>
      <ImageThumb
        key={item.id}
        item={item}
        label={label ?? t("media.thumb.open", { name: item.name })}
        onOpen={() => setOpen(true)}
        className={className}
        imgClassName={imgClassName}
      />
      {open && <ImageLightbox items={items} index={0} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Several images from one message. Previous/next stays inside `items`: the
 * set the caller was already allowed to show, never a wider cache. */
export function ImageGallery({ items, className, thumbClassName, imgClassName, label }: {
  items: ImageMediaItem[];
  className?: string;
  thumbClassName?: string;
  imgClassName?: string;
  label: (item: ImageMediaItem) => string;
}) {
  // selection by identity: if the set changes under an open dialog, a removed
  // image closes it instead of the index silently landing on a neighbour
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const index = selectedId === null ? -1 : items.findIndex((item) => item.id === selectedId);
  if (items.length === 0) return null;
  return (
    <>
      <div className={className}>
        {items.map((item) => (
          <ImageThumb
            key={item.id}
            item={item}
            label={label(item)}
            onOpen={() => setSelectedId(item.id)}
            className={thumbClassName}
            imgClassName={imgClassName}
          />
        ))}
      </div>
      {index >= 0 && (
        <ImageLightbox
          items={items}
          index={index}
          onIndexChange={(next) => setSelectedId(items[next]?.id ?? null)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}

// ── Lightbox ─────────────────────────────────────────────────────────────

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const HEADER_BUTTON = "flex size-9 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

function LightboxImage({ item }: { item: ImageMediaItem }) {
  // keyed by item.id by the caller: a failure belongs to one image only
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex flex-col items-center gap-3 text-white/60" role="status">
        <ImageOff size={34} aria-hidden="true" />
        <span className="text-[13px]">{t("media.lightbox.unavailable")}</span>
      </div>
    );
  }
  return (
    <img
      src={item.src}
      alt={item.alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      data-testid="image-lightbox-image"
      className="block max-h-full max-w-full rounded-lg object-contain shadow-2xl"
    />
  );
}

export function ImageLightbox({ items, index, onIndexChange, onClose }: {
  items: ImageMediaItem[];
  index: number;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  const item = items[Math.min(Math.max(index, 0), items.length - 1)];
  const count = items.length;
  const position = Math.min(Math.max(index, 0), count - 1);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // not connected or already modal elsewhere: fall back to a plain open dialog
        dialog.setAttribute("open", "");
      }
    }
    dialog?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      // back to the thumbnail that opened it, if it is still on screen
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const go = useCallback((next: number | null) => {
    if (next === null || !onIndexChange) return;
    onIndexChange(next);
  }, [onIndexChange]);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    // the dialog is portalled, but React still bubbles its events to the
    // component that opened it: a transcript bubble must not see this key
    event.stopPropagation();
    const next = nextLightboxIndex(position, count, event.key);
    if (next !== null && onIndexChange) {
      event.preventDefault();
      go(next);
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Escape arrives as `cancel`; a browser that skips cancel closes the dialog
  // and fires `close`. Either way only this dialog closes: neither event may
  // reach a parent dialog (the Files browser) through React's tree.
  const onCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    event.stopPropagation();
    closeRef.current();
  };
  const onNativeClose = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    // `close` is queued, not dispatched inline. StrictMode (src/main.tsx, the
    // dev server and the e2e rig) runs the open effect, its cleanup, then the
    // effect again: the cleanup's close() event lands after the dialog is modal
    // again. A close that finds the dialog open is that stale echo, not a
    // person closing it.
    if (event.currentTarget.open) return;
    closeRef.current();
  };
  const stop = (event: SyntheticEvent) => event.stopPropagation();

  if (!item) return null;
  const sourceLabel = imageSourceLabel(item.source);
  const positionLabel = count > 1 ? t("media.lightbox.position", { index: position + 1, count }) : "";

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label={t("media.lightbox.label", { name: item.name })}
      aria-describedby="image-lightbox-meta"
      tabIndex={-1}
      data-testid="image-lightbox"
      onKeyDown={onKeyDown}
      onCancel={onCancel}
      onClose={onNativeClose}
      onClick={stop}
      onMouseDown={(event) => {
        event.stopPropagation();
        // the dialog fills the viewport; only its bare backdrop area is itself
        if (event.target === event.currentTarget) closeRef.current();
      }}
      className="fixed inset-0 m-0 hidden h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-3 text-white outline-none open:flex backdrop:bg-black/80 backdrop:backdrop-blur-sm sm:p-6"
    >
      <div className="animate-pop-in flex h-full max-h-[900px] w-full max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-white/15 bg-black/70 shadow-2xl motion-reduce:animate-none">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-black/45 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-white">{item.name}</div>
            <div id="image-lightbox-meta" className="truncate text-[10.5px] text-white/55">
              {positionLabel && <span aria-live="polite">{positionLabel} · </span>}
              {sourceLabel}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {item.reference && (
              <UseAsReferenceButton
                key={item.id}
                source={item.reference.source}
                {...(item.reference.threadId ? { threadId: item.reference.threadId } : {})}
                {...(item.reference.botId ? { botId: item.reference.botId } : {})}
                name={item.name}
                className="mr-1 rounded-lg px-2.5 py-1.5 text-[12px] text-white/75 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                statusClassName="text-white/60"
              />
            )}
            {count > 1 && onIndexChange && (
              <>
                <button type="button" onClick={() => go(nextLightboxIndex(position, count, "ArrowLeft"))} className={HEADER_BUTTON} aria-label={t("media.lightbox.previous")} title={t("media.lightbox.previous")}>
                  <ChevronLeft size={18} aria-hidden="true" />
                </button>
                <button type="button" onClick={() => go(nextLightboxIndex(position, count, "ArrowRight"))} className={HEADER_BUTTON} aria-label={t("media.lightbox.next")} title={t("media.lightbox.next")}>
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              </>
            )}
            {item.download && (
              <a
                href={item.src}
                download={item.name}
                referrerPolicy="no-referrer"
                className={HEADER_BUTTON}
                aria-label={t("media.lightbox.download", { name: item.name })}
                title={t("media.lightbox.downloadTitle")}
              >
                <Download size={17} aria-hidden="true" />
              </a>
            )}
            <button type="button" onClick={() => closeRef.current()} className={HEADER_BUTTON} aria-label={t("media.lightbox.close")} title={t("media.lightbox.close")}>
              <X size={19} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4 sm:p-8">
          <LightboxImage key={item.id} item={item} />
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

// ── Surface wrappers ─────────────────────────────────────────────────────

/** A screen frame from the bot's computer, enlargeable in place. */
export function ScreenFrameMedia({ png, mime, className }: { png: string; mime?: string; className?: string }) {
  const item = useMemo(() => screenFrameItem(png, mime), [png, mime]);
  return <ImageMedia item={item} label={t("media.screenFrame.open")} className={className} imgClassName="h-auto w-full" />;
}

/** The Files browser's saved-copy image preview. */
export function ArtifactImageMedia({ artifact, content }: { artifact: ArtifactImage; content: string | undefined }) {
  const item = useMemo(() => artifactImageItem(artifact, content), [artifact, content]);
  if (!item) return <p className="mt-3 text-[13px] text-ink-secondary">{t("media.artifact.unavailable")}</p>;
  return (
    <div className="mt-3">
      <ImageMedia item={item} className="rounded-lg" imgClassName="max-h-96 object-contain" />
    </div>
  );
}

const CARD = "my-1 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-hairline/40 bg-inset/70 px-2.5 py-1.5 align-top text-[12px] text-ink-secondary";

/** A Markdown `![alt](src)` inside a chat or room message. Rendered inside a
 * paragraph, so everything here is phrasing content (spans, buttons, img). */
export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const resolved = useMemo(() => resolveMarkdownImage(src, alt), [src, alt]);
  // permission to fetch lasts as long as this rendered image, and only for
  // the exact URL that was shown when the person clicked Load
  const [allowedUrl, setAllowedUrl] = useState<string | null>(null);

  if (resolved.kind === "inline") {
    return <ImageMedia item={resolved.item} className="my-1 rounded-lg border border-hairline/30" imgClassName="max-h-96" />;
  }
  if (resolved.kind === "external") {
    if (allowedUrl === resolved.url) {
      const name = resolved.alt || resolved.host;
      return (
        <ImageMedia
          item={{ id: `external:${resolved.url}`, src: resolved.url, name, alt: resolved.alt, source: "external-link", download: false }}
          className="my-1 rounded-lg border border-hairline/30"
          imgClassName="max-h-96"
        />
      );
    }
    return (
      <span className={CARD} data-image-media-state="external">
        <ImageOff size={13} className="shrink-0" aria-hidden="true" />
        {resolved.alt && <span className="min-w-0 text-ink">{resolved.alt}</span>}
        <span className="min-w-0">{t("media.external.notLoaded", { host: resolved.host })}</span>
        <button
          type="button"
          onClick={() => setAllowedUrl(resolved.url)}
          className="rounded px-1.5 py-0.5 text-accent underline decoration-accent/40 hover:decoration-accent focus-visible:outline-2 focus-visible:outline-focus"
        >
          {t("media.external.load")}
        </button>
      </span>
    );
  }
  return (
    <span className={CARD} data-image-media-state="local">
      <ImageOff size={13} className="shrink-0" aria-hidden="true" />
      {resolved.alt && <span className="min-w-0 text-ink">{resolved.alt}</span>}
      <span className="min-w-0">{t("media.local.notLoaded")}</span>
    </span>
  );
}
