// Saved-file cards inside a chat message (0.1.52 INLINE1). A "Saved file" card
// shows the thing it is about — the image, the player, the first part of the
// document — in the card itself, at one glance, without leaving the chat.
// Preview never navigates to the Files section unless the inline preview
// could not load; the Files section's own preview is unchanged.
//
// What a card will not do:
// - Fetch bytes without a capability. Image and player bytes come only from
//   the URL the media resolver issued for this exact saved version (F5-T1,
//   U-03): a same-origin byte route carrying a short-lived capability. The
//   card never builds a bytes URL, never uses a data: URL for a saved image
//   and never reads a path.
// - Reach across conversations. It asks about the artifact ids the server put
//   on this message, by id; the harness authorizes each one by the scopes the
//   Files section already uses.
// - Render a whole document. Text is bounded: a first slice, "Show more" up
//   to a fixed ceiling, and the working file in the pane (Open here) or a
//   Download for the rest.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, useStore } from "@/state/store";
import { mediaHintForPath } from "@/lib/composer-attachments";
import { artifactReferenceSource } from "@/lib/image-reference";
import { t } from "@/lib/i18n";
import { useDesktopSurface } from "@/lib/use-surface";
import { isMarkdownPath } from "@/lib/workspace-pane";
import { ChatMarkdown, CodeBlock } from "./ChatMarkdown";
import { ArtifactCard, artifactNativeAction, artifactPreviewHtml, downloadSavedArtifact, openFiles } from "./Files";
import { ImageMedia, type ImageMediaItem } from "./ImageMedia";
import { MediaPlayerCard, MediaUnplayableCard, unplayableMessage, type MediaSource } from "./MediaPlayer";
import type { MediaUnplayableReason } from "@/lib/media-resolve";
import { isMediaCapabilityToken, MEDIA_CAPABILITY_QUERY_PARAM, MEDIA_ROUTES, type MediaAsset, type MediaResolveResponse } from "../../shared/media-assets";
import type { Artifact, ArtifactPreview } from "../../shared/artifacts";

// ── Pure rules (tested without a DOM) ────────────────────────────────────

/** What a card embeds for one saved version. `none` keeps today's buttons. */
export type ArtifactInlineKind = "image" | "audio" | "video" | "markdown" | "code" | "html" | "none";

/** Decided from what the server registered (kind, filename, saved state),
 * never from bytes: the bytes are only asked for once this says so. */
export function artifactInlineKind(artifact: Pick<Artifact, "kind" | "filename" | "savedState">): ArtifactInlineKind {
  if (artifact.savedState !== "available") return "none";
  if (artifact.kind === "image") return "image";
  if (artifact.kind === "html") return "html";
  if (artifact.kind === "text") return isMarkdownPath(artifact.filename) ? "markdown" : "code";
  // The server files audio and video under "other"; the container name says
  // whether a player is worth asking for. The resolver sniffs the bytes.
  const hint = mediaHintForPath(artifact.filename);
  return hint ? hint.kind : "none";
}

/** The shiki language for a text artifact, from its extension. */
export function artifactCodeLanguage(filename: string): string {
  const match = /\.([a-z0-9]{1,12})$/i.exec(filename);
  const extension = match ? match[1]!.toLowerCase() : "";
  if (extension === "txt" || extension === "") return "text";
  return extension;
}

/** First slice of a text preview, then up to a ceiling on Show more. */
export const ARTIFACT_INLINE_COLLAPSED_CHARS = 2_048;
export const ARTIFACT_INLINE_EXPANDED_CHARS = 262_144;

export interface ArtifactTextSlice { text: string; truncated: boolean; expandable: boolean }

/** Bound a document for the card. A cut lands on a line boundary when one is
 * near, so a heading or fence is not sliced in half. `expandable` says a
 * Show more would reveal anything the ceiling still allows. */
export function artifactTextSlice(content: string, expanded: boolean): ArtifactTextSlice {
  const limit = expanded ? ARTIFACT_INLINE_EXPANDED_CHARS : ARTIFACT_INLINE_COLLAPSED_CHARS;
  if (content.length <= limit) return { text: content, truncated: false, expandable: false };
  const newline = content.lastIndexOf("\n", limit);
  const cut = newline > limit / 2 ? newline : limit;
  return { text: content.slice(0, cut), truncated: true, expandable: !expanded };
}

/** Accept a resolver answer only when it is a ready asset with a byte URL on
 * this harness's own route carrying a capability (U-03). Anything else —
 * a path, a data: URL, a bare bytes URL, another origin — is refused and the
 * card falls back rather than fetching. */
export function acceptedArtifactMedia(response: MediaResolveResponse | null | undefined): { asset: MediaAsset; url: string; expiresAt?: number } | null {
  const asset = response?.asset, url = response?.url;
  if (!asset || typeof asset.id !== "string" || asset.availability !== "ready" || typeof url !== "string") return null;
  if (!url.startsWith(`${MEDIA_ROUTES.bytes}/`)) return null;
  let cap: string | null;
  try { cap = new URL(url, "http://murage.invalid").searchParams.get(MEDIA_CAPABILITY_QUERY_PARAM); } catch { return null; }
  if (!isMediaCapabilityToken(cap)) return null;
  return { asset, url, ...(typeof response.expiresAt === "number" ? { expiresAt: response.expiresAt } : {}) };
}

/** The saved image, keyed by its pinned digest, reading the capability URL
 * the resolver issued. Same lightbox, same "Use as reference" rule as the
 * Files preview. */
export function artifactMediaImageItem(artifact: Pick<Artifact, "id" | "name" | "sha256" | "mime" | "bytes" | "threadId" | "botId">, url: string): ImageMediaItem {
  const source = artifactReferenceSource(artifact);
  return {
    id: `artifact:${artifact.id}:${artifact.sha256}`, src: url, name: artifact.name, alt: artifact.name, source: "artifact", download: true,
    ...(source ? { reference: { source, threadId: artifact.threadId, botId: artifact.botId } } : {}),
  };
}

function unplayableReasonFor(asset: MediaAsset): MediaUnplayableReason {
  if (asset.availability === "missing") return "missing";
  if (asset.availability === "changed") return "changed";
  if (asset.availability === "denied") return "denied";
  return "unsupported";
}

// ── Inline content ───────────────────────────────────────────────────────

type Inline =
  | { status: "loading" }
  | { status: "image"; item: ImageMediaItem }
  | { status: "player"; asset: MediaAsset; url: string; expiresAt?: number }
  | { status: "unplayable"; asset: MediaAsset; reason: MediaUnplayableReason }
  | { status: "text"; content: string }
  | { status: "html"; content: string }
  | { status: "failed" };

const resolveArtifactMedia = (artifactId: string, signal?: AbortSignal) =>
  api(MEDIA_ROUTES.resolve, { method: "POST", body: JSON.stringify({ ref: { source: "artifact", artifactId } }), signal }) as Promise<MediaResolveResponse>;

const link = "rounded px-1.5 py-0.5 text-[12px] text-accent underline decoration-accent/40 hover:decoration-accent focus-visible:outline-2 focus-visible:outline-focus";

function BoundedText({ artifact, content, kind }: { artifact: Artifact; content: string; kind: "markdown" | "code" }) {
  const [expanded, setExpanded] = useState(false);
  const slice = useMemo(() => artifactTextSlice(content, expanded), [content, expanded]);
  const scope = useMemo(() => ({ botId: artifact.botId, threadId: artifact.threadId }), [artifact.botId, artifact.threadId]);
  return (
    <div data-artifact-inline={kind} data-artifact-inline-expanded={expanded ? "true" : "false"}>
      {kind === "markdown"
        ? <div className="rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px]"><ChatMarkdown text={slice.text} scope={scope} /></div>
        : <CodeBlock code={slice.text} lang={artifactCodeLanguage(artifact.filename)} streaming={false} />}
      {(slice.truncated || expanded) && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-secondary">
          {slice.truncated && <span>{t("artifactCard.truncated", { shown: Math.round(slice.text.length / 1024).toLocaleString(), total: Math.max(1, Math.round(content.length / 1024)).toLocaleString() })}</span>}
          {slice.expandable && <button type="button" className={link} onClick={() => setExpanded(true)}>{t("artifactCard.showMore")}</button>}
          {expanded && <button type="button" className={link} onClick={() => setExpanded(false)}>{t("artifactCard.showLess")}</button>}
        </p>
      )}
    </div>
  );
}

function HtmlFrame({ artifact, content }: { artifact: Artifact; content: string }) {
  const [large, setLarge] = useState(false);
  const html = useMemo(() => artifactPreviewHtml(content), [content]);
  return (
    <div data-artifact-inline="html">
      <iframe title={t("artifactCard.htmlFrame", { name: artifact.name })} sandbox="" referrerPolicy="no-referrer" srcDoc={html}
        className={`w-full rounded-lg bg-white ${large ? "h-[560px]" : "h-72"}`} />
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-secondary">
        <span>{t("artifactCard.htmlNote")}</span>
        <button type="button" className={link} onClick={() => setLarge(value => !value)}>{large ? t("artifactCard.smaller") : t("artifactCard.larger")}</button>
      </p>
    </div>
  );
}

/** One card. The inline content is asked for once per saved version; a
 * change of digest or saved state starts over. */
export function InlineArtifactCard({ artifact, busy, onDownload, onNativeAction, onOpenHere }: {
  artifact: Artifact; busy: boolean; onDownload: () => void;
  onNativeAction?: (file: Artifact, operation: "open" | "reveal") => void; onOpenHere: () => void;
}) {
  const kind = artifactInlineKind(artifact);
  const [inline, setInline] = useState<Inline>(kind === "none" ? { status: "failed" } : { status: "loading" });
  useEffect(() => {
    if (kind === "none") { setInline({ status: "failed" }); return; }
    const controller = new AbortController();
    setInline({ status: "loading" });
    void (async () => {
      try {
        if (kind === "image" || kind === "audio" || kind === "video") {
          const response = await resolveArtifactMedia(artifact.id, controller.signal);
          if (controller.signal.aborted) return;
          const accepted = acceptedArtifactMedia(response);
          if (accepted && kind === "image" && accepted.asset.kind === "image") { setInline({ status: "image", item: artifactMediaImageItem(artifact, accepted.url) }); return; }
          if (accepted && kind !== "image" && (accepted.asset.kind === "audio" || accepted.asset.kind === "video")) { setInline({ status: "player", ...accepted }); return; }
          // The harness knows the file but will not stream it here (or it is
          // not what its name said): say so for media; images fall back.
          if (kind !== "image" && response?.asset && typeof response.asset.id === "string") { setInline({ status: "unplayable", asset: response.asset, reason: unplayableReasonFor(response.asset) }); return; }
          setInline({ status: "failed" });
          return;
        }
        const preview = await api(`/api/artifacts/${artifact.id}/preview`, { signal: controller.signal }) as ArtifactPreview;
        if (controller.signal.aborted) return;
        if (kind === "html" && preview.mode === "html" && typeof preview.content === "string") { setInline({ status: "html", content: preview.content }); return; }
        if (kind !== "html" && preview.mode === "text" && typeof preview.content === "string") { setInline({ status: "text", content: preview.content }); return; }
        setInline({ status: "failed" });
      } catch { if (!controller.signal.aborted) setInline({ status: "failed" }); }
    })();
    return () => controller.abort();
  }, [artifact, kind]);
  // A player whose capability expired asks for a fresh one for the same
  // pinned version; anything but a ready answer ends playback truthfully.
  const refresh = useCallback(async (): Promise<MediaSource | null> => {
    try {
      const accepted = acceptedArtifactMedia(await resolveArtifactMedia(artifact.id));
      if (accepted && (accepted.asset.kind === "audio" || accepted.asset.kind === "video")) return { url: accepted.url, ...(accepted.expiresAt !== undefined ? { expiresAt: accepted.expiresAt } : {}) };
    } catch { /* falls through */ }
    return null;
  }, [artifact.id]);

  let content: ReactNode = null;
  switch (inline.status) {
    case "loading": content = <p role="status" className="text-[12px] text-ink-secondary" data-artifact-inline="loading">{t("artifactCard.loading")}</p>; break;
    case "image": content = <div data-artifact-inline="image"><ImageMedia item={inline.item} className="rounded-lg border border-hairline/40 bg-panel" imgClassName="max-h-80 object-contain" /></div>; break;
    case "player": content = <div data-artifact-inline={inline.asset.kind}><MediaPlayerCard key={`${inline.asset.id}:${inline.asset.revision ?? ""}`} asset={inline.asset} url={inline.url} expiresAt={inline.expiresAt} refresh={refresh} /></div>; break;
    case "unplayable": content = <div data-artifact-inline={inline.asset.kind}><MediaUnplayableCard asset={inline.asset} reason={unplayableMessage(inline.reason)} /></div>; break;
    case "text": content = <BoundedText artifact={artifact} content={inline.content} kind={kind === "markdown" ? "markdown" : "code"} />; break;
    case "html": content = <HtmlFrame artifact={artifact} content={inline.content} />; break;
    case "failed": content = null; break;
  }
  // Preview in Files stays only as the fallback for a format the card could
  // not show here; a card that shows the thing offers no Preview at all.
  const previewFallback = inline.status === "failed" && (kind === "image" || kind === "html" || kind === "markdown" || kind === "code");
  return <ArtifactCard artifact={artifact} busy={busy}
    inline={content}
    inlineNote={previewFallback ? t("artifactCard.previewFailed") : undefined}
    onPreview={previewFallback || (kind === "none" && artifact.kind !== "other") ? () => openFiles({ artifactId: artifact.id, botId: artifact.botId }) : undefined}
    onOpenHere={onOpenHere}
    onDownload={onDownload}
    onNativeAction={onNativeAction} />;
}

/** IDs are supplied only by the server after registration; never parse paths
 * or prose into cards. Metadata reads do not fetch or execute file content. */
export function ArtifactCards({ ids }: { ids: string[] }) {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface(), [artifacts, setArtifacts] = useState<Artifact[]>([]), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const key = [...new Set(ids.filter(id => /^[a-f0-9-]{36}$/.test(id)))].slice(0, 20).join(",");
  useEffect(() => {
    setArtifacts([]);
    if (desktop !== true || !key) return;
    const controller = new AbortController(); setError(null);
    void Promise.all(key.split(",").map(id => api(`/api/artifacts/${id}`, { signal: controller.signal }))).then(values => {
      if (!controller.signal.aborted) setArtifacts(values.map(value => value.artifact as Artifact));
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Saved files could not load."); });
    return () => controller.abort();
  }, [key, desktop]);
  const action = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null); try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The file could not be opened."); } finally { setBusy(false); }
  };
  if (desktop !== true) return null;
  const native = artifactNativeAction();
  return <div className="mt-3 space-y-2" aria-label="Saved files">
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    {artifacts.map(artifact => <InlineArtifactCard key={artifact.id} artifact={artifact} busy={busy}
      // Open here (F4-T3): the working file this version came from, in the
      // pane beside this chat, named by the identity the server registered.
      onOpenHere={() => dispatch({ type: "workspacePane", action: { type: "open", scope: { botId: artifact.botId, threadId: artifact.threadId }, relativePath: artifact.relativePath, mode: "preview" } })}
      onDownload={() => { void action(() => downloadSavedArtifact(artifact)); }}
      onNativeAction={native ? (file, operation) => { void action(() => native(file, operation)); } : undefined} />)}
  </div>;
}
