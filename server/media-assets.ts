// Scoped media assets, authorized byte serving and image-reference promotion.
// K0 skeleton: routed and gated, answers 501 until F5-T1 (resolve, bytes)
// and F5-T4 (resolve-image-reference) fill it in.
// Contract: shared/media-assets.ts and docs/plans/0152-CONTRACTS.md.
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactScope } from "./artifacts.ts";
import type { Store } from "./store.ts";
import { MEDIA_ROUTE_PREFIX } from "../shared/media-assets.ts";
import { hiddenRoute, notImplemented, type DelegatedRequest, type DelegatedResult } from "./route-delegation.ts";

export interface MediaAssetsDeps {
  dataDir: string;
  database: () => DatabaseSync;
  store: Store;
  artifactScopes: () => ArtifactScope[];
}

/** /api/media/*. Desktop proof is required for everything except
 * `/api/media/bytes/*`, which F5-T1 authorizes with the U-03 capability
 * token because <audio>/<video>/<img> cannot send the desktop header. Until
 * capabilities exist, bytes are hidden from non-desktop callers too. */
export async function mediaAssetsRoute(request: DelegatedRequest, _deps: MediaAssetsDeps): Promise<DelegatedResult> {
  if (!request.desktop) return hiddenRoute();
  if (request.path !== MEDIA_ROUTE_PREFIX && !request.path.startsWith(`${MEDIA_ROUTE_PREFIX}/`)) return hiddenRoute();
  return notImplemented("Media assets are not available in this build.");
}

/** Identity taken from the verified internal capability, never the body. */
export interface ImageReferenceClaim { botId: string; threadId: string; generation: string }

/** POST /api/internal/resolve-image-reference, reached only after
 * server/index.ts verified an active agents capability for this turn. */
export async function resolveImageReferenceRoute(request: DelegatedRequest, _claim: ImageReferenceClaim, _deps: MediaAssetsDeps): Promise<DelegatedResult> {
  if (request.method !== "POST") return { status: 405, body: { error: "resolve-image-reference requires POST" } };
  return notImplemented("Image references from files are not available in this build.");
}
