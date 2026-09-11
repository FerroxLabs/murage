/**
 * Frozen 0.1.52 contract (K0): one scoped media descriptor for every chat,
 * gallery, Files and player surface, and one exact-byte image reference
 * contract for IMG-SEED.
 *
 * Consumers: server/media-assets.ts (F5-T1), ImageMedia/lightbox (F5-T2),
 * MediaPlayer (F5-T3), server image-reference resolver (F5-T4), F5-T5.
 *
 * Rules:
 * - A descriptor never carries a secret, an absolute root, a provider URL or
 *   a permanent download token.
 * - Byte URLs use a short-lived HMAC capability bound to asset, revision and
 *   the desktop surface (U-03). The reusable desktop secret never appears in
 *   a URL. Capability values are redacted from logs and responses carry
 *   `Referrer-Policy: no-referrer`.
 * - Every route is desktop-only in 0.1.52; the companion keeps default deny (U-04).
 * - An image reference is resolved to pinned bytes before approval/billing;
 *   one failed reference fails the whole request.
 */
import { isWorkspaceRelativePath, type FileRevision, type WorkspaceScopeRef } from "./workspace-files.ts";

export const MEDIA_ASSET_SOURCES = ["attachment", "artifact", "workspace", "screen-frame", "external-link"] as const;
export type MediaAssetSource = typeof MEDIA_ASSET_SOURCES[number];
export const MEDIA_ASSET_KINDS = ["image", "audio", "video", "file"] as const;
export type MediaAssetKind = typeof MEDIA_ASSET_KINDS[number];
export const MEDIA_ASSET_AVAILABILITY = ["ready", "loading", "missing", "denied", "unsupported", "changed"] as const;
export type MediaAssetAvailability = typeof MEDIA_ASSET_AVAILABILITY[number];

/** Exactly the media design's descriptor. */
export type MediaAsset = {
  /** Opaque server asset identity or scoped ephemeral identity. */
  id: string;
  scope: { serverId: string; botId: string; threadId: string; messageId?: string };
  source: MediaAssetSource;
  kind: MediaAssetKind;
  name: string;
  mime: string;
  bytes?: number;
  /** Pinned digest/version, not mtime alone. */
  revision?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  availability: MediaAssetAvailability;
  capabilities: { preview: boolean; download: boolean; open: boolean; reveal: boolean; imageReference: boolean };
};

/** What the renderer asks the server to resolve. Screen frames and external
 * links never go to the server: they use already delivered bytes or an
 * explicit external-content card. */
export type MediaAssetRef =
  | { source: "attachment"; threadId: string; attachmentId: string }
  | { source: "artifact"; artifactId: string }
  | { source: "workspace"; scope: WorkspaceScopeRef; relativePath: string; revision: FileRevision };

export const MEDIA_ROUTE_PREFIX = "/api/media";
export const MEDIA_ROUTES = {
  /** POST { ref: MediaAssetRef } -> MediaResolveResponse (desktop proof required) */
  resolve: `${MEDIA_ROUTE_PREFIX}/resolve`,
  /** GET/HEAD `${bytes}/<assetId>?cap=<token>`; single byte range, 206/416 */
  bytes: `${MEDIA_ROUTE_PREFIX}/bytes`,
} as const;

export interface MediaResolveResponse {
  asset: MediaAsset;
  /** Same-origin byte URL carrying a capability; absent unless `ready`. */
  url?: string;
  expiresAt?: number;
}

/** U-03 capability transport. */
export const MEDIA_CAPABILITY_QUERY_PARAM = "cap";
export const MEDIA_CAPABILITY_TTL_MS = 10 * 60 * 1000;
export const MEDIA_CAPABILITY_VERSION = "mc1";
export interface MediaCapabilityClaims {
  v: 1;
  assetId: string;
  revision: string;
  surface: "desktop";
  /** Expiry, epoch milliseconds. */
  exp: number;
}
/** `mc1.<base64url claims>.<base64url HMAC-SHA256>` */
export function isMediaCapabilityToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1_024 && /^mc1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{43}$/.test(value);
}

export const MEDIA_BYTES_RESPONSE_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "private, no-store",
  "cross-origin-resource-policy": "same-origin",
} as const;

/** Replace every capability value in a URL or log line. */
export function redactMediaCapability(text: string): string {
  return text.replace(new RegExp(`([?&]${MEDIA_CAPABILITY_QUERY_PARAM}=)[^&#\\s"']*`, "g"), "$1[redacted]");
}

/** U-28 initial playback set (still gated by canPlayType and error fallback). */
export const MEDIA_PLAYABLE_MIMES = {
  audio: ["audio/wav", "audio/mpeg", "audio/ogg", "audio/mp4"],
  video: ["video/mp4", "video/webm"],
} as const;

export const IMAGE_REFERENCE_ROUTE = "/api/internal/resolve-image-reference";
export const IMAGE_REFERENCE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageReferenceMime = typeof IMAGE_REFERENCE_MIMES[number];
/** Matches server/image-operations.ts and attachments IMAGE_MAX_BYTES. */
export const IMAGE_REFERENCE_LIMITS = {
  maxCount: 4,
  maxBytesEach: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
} as const;

/** One discriminated source. The server derives bot/thread/cwd from the
 * internal capability claim; no root, absolute path or URL is accepted. */
export type ImageReferenceSource =
  /** Existing conversation attachment reference id (e.g. `<uuid>.png`). */
  | { kind: "attachment"; attachmentId: string }
  /** A saved Files version, pinned by its digest. */
  | { kind: "artifact"; artifactId: string; sha256: string }
  /** A file in the current task workspace, optionally pinned to a revision. */
  | { kind: "workspace"; relativePath: string; revision?: FileRevision };

export interface ResolveImageReferenceRequest { source: ImageReferenceSource }

export interface ResolvedImageReference {
  /** Opaque reference id usable in image MCP `reference_ids`. */
  id: string;
  sha256: string;
  mime: ImageReferenceMime;
  bytes: number;
  source: ImageReferenceSource["kind"];
  width?: number;
  height?: number;
}

export function isImageReferenceSource(value: unknown): value is ImageReferenceSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (v.kind === "attachment") return keys === "attachmentId,kind" && typeof v.attachmentId === "string" && /^[\w-]{1,160}\.(png|jpg|jpeg|webp)$/i.test(v.attachmentId);
  if (v.kind === "artifact") return keys === "artifactId,kind,sha256" && typeof v.artifactId === "string" && /^[a-f0-9-]{36}$/.test(v.artifactId) && typeof v.sha256 === "string" && /^[a-f0-9]{64}$/.test(v.sha256);
  if (v.kind === "workspace") {
    if (keys !== "kind,relativePath" && keys !== "kind,relativePath,revision") return false;
    if (!isWorkspaceRelativePath(v.relativePath)) return false;
    return v.revision === undefined || (typeof v.revision === "string" && /^[A-Za-z0-9_.:-]{8,256}$/.test(v.revision));
  }
  return false;
}
