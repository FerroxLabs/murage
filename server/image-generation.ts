import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { redactSecretsInText } from "./redact.ts";
import { IMAGE_GENERATION_REFERENCE_MAX, IMAGE_GENERATION_REFERENCE_MAX_TOTAL_BYTES } from "../shared/media-assets.ts";
import { GENERATED_IMAGE_MAX_BYTES, GENERATED_IMAGE_RECEIVE_MAX_BYTES, decodeGeneratedImage, type DecodedGeneratedImage } from "./generated-image.ts";
import {
  FLUX_FAMILY_IDS, FLUX_LEGACY_IDS, IMAGE_FORMATS, IMAGE_NEGATIVE_PROMPT_MAX, IMAGE_PROMPT_HARD_MAX, IMAGE_QUALITIES, IMAGE_RESOLUTIONS, OPENAI_IMAGE_MODELS,
  assembleImagePrompt, builtInImageCapabilities, exactTarget, fluxBuiltInModels, openRouterCapabilities, parseFluxImageCatalogue, promptTooLongMessage,
  resolveImageSize, sentModelFor, type FluxCatalogue, type ImageModelCapabilities, type ImageSizeRequest, type ResolvedImageSize,
} from "../shared/image-capabilities.ts";
import {
  BUFFERED_DEADLINE_MS, ImageDeliveryError, LONG_RENDER_SECONDS, RENDER_CEILING_MS, defaultSleep, idleTimeoutMs, idleWatch, parseImageJob, pollImageJob, readImageEventStream,
} from "./image-delivery.ts";
import { loadCrop, type CropImage } from "./image-fit.ts";
import { sniffMedia } from "./media-assets.ts";
import { IMAGE_PROMPT_BLOCKS_MAX } from "./image-library.ts";

export type ImageProvider = "openai" | "flux" | "openrouter" | "xai" | "google";
/** Only the server connection resolver constructs this object. Never serialize it. */
export interface ImageConnection { id: string; provider: ImageProvider; apiKey: string; revision: string }
export interface ImageReference { bytes: Buffer; mime: "image/png" | "image/jpeg" | "image/webp" }
export const imageGenerationRequestSchema = z.object({
  connectionId: z.string().min(1).max(160), model: z.string().min(1).max(180).optional(),
  operation: z.enum(["generate", "edit"]).default("generate"),
  /** The scene. Optional when saved prompt blocks carry the prompt. */
  prompt: z.string().trim().max(IMAGE_PROMPT_HARD_MAX).optional(),
  quality: z.enum(IMAGE_QUALITIES).optional(),
  /** Legacy "WxH": width and height with fit nearest. */
  size: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(),
  aspectRatio: z.string().max(8).optional(), resolution: z.enum(IMAGE_RESOLUTIONS).optional(),
  width: z.number().int().min(64).max(8192).optional(), height: z.number().int().min(64).max(8192).optional(),
  fit: z.enum(["nearest", "exact"]).optional(),
  n: z.number().int().min(1).max(10).optional(),
  outputFormat: z.enum(IMAGE_FORMATS).optional(), outputCompression: z.number().int().min(0).max(100).optional(),
  background: z.enum(["transparent"]).optional(), seed: z.number().int().min(0).max(2_147_483_647).optional(),
  negativePrompt: z.string().trim().min(1).max(IMAGE_NEGATIVE_PROMPT_MAX).optional(),
  condensedFromChars: z.number().int().min(1).max(10_000_000).optional(),
}).strict();
export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;
export interface ImageModelOption {
  id: string; label: string; generate: boolean; edit: boolean;
  /** "verified" / "failed": the model's own last check on this connection
   * (a failed model is marked, never hidden); "catalog-listed": the provider
   * lists it; "unverified": not checked yet. */
  availability: "unverified" | "catalog-listed" | "verified" | "failed"; disabledReason?: string;
  /** When the last check worked or failed, and why it failed. */
  lastGoodAt?: number; lastFailedAt?: number; lastError?: string;
  /** Flux: false when the key's own model list does not name it. */
  offeredToKey?: boolean;
  /** Kept for older views; `capabilities` is the full statement. */
  qualities: string[]; sizes: string[]; outputFormat?: "png" | "jpeg" | "webp";
  /** Most reference images this adapter sends for one edit. 0 when editing is unavailable. Never above Murage's shared cap. */
  maxReferences: number;
  /** Why editing is unavailable for this model, when it is. */
  editUnavailableReason?: string;
  /** Edit-specific quality support when it differs from generation. xAI edits take no quality field. */
  editQualities?: string[];
  capabilities: ImageModelCapabilities;
  /** An older id that stands for a base model at a fixed quality and size. */
  aliasOf?: string;
  /** What the Flux catalogue says about the model right now, when it says. */
  status?: { state: "ok" | "degraded" | "down"; checkedAt?: string; lastGoodAt?: string };
}
export interface ImageCatalog {
  connectionId: string; provider: ImageProvider; defaultModel: string | null; models: ImageModelOption[];
  /** Flux: whether model details came from the router or Murage's built-in table. */
  capabilitySource?: "catalogue" | "built-in";
}
export type ImageAttemptOutcome = "not-dispatched" | "failed" | "uncertain" | "published";
export type ImageDelivery = "stream" | "job" | "buffered";
export interface ImageOperationDetails {
  connectionId: string; provider: ImageProvider; model: string; operation: "generate" | "edit";
  /** The connection's name as Settings shows it (redacted); the card uses it, never the raw id. */
  connectionLabel?: string;
  /** Images asked for. */
  count: number; referenceCount: number; quality?: string;
  /** The pixels rendered, "WxH", when the model takes a pixel size. */
  size?: string;
  /** OpenRouter only: the upstream endpoint pinned before owner approval. */
  endpointTag?: string;
  /** The id actually sent when it differs from `model` (a Flux quality alias). */
  sentModel?: string;
  sizeAsked?: string; sizeRendered?: string;
  /** fit exact: the pixels (or ratio) the render is cropped and resized to here. */
  cropTo?: string;
  experimentalSize?: boolean;
  /** Characters of the assembled prompt, exactly as sent (JS length after trim). */
  promptChars?: number; promptSha256?: string;
  condensedFromChars?: number;
  /** The negative prompt went in as an "Avoid:" line. */
  avoidLine?: boolean;
  /** A native negative prompt sent in its own field: its length. */
  negativeChars?: number;
  outputFormat?: string; outputCompression?: number; background?: "transparent"; seed?: number;
  /** The model's reference cap, stated on the card. */
  referenceCap?: number;
  /** Phase 2 seams: a saved reference pack and saved prompt blocks. */
  referencePack?: { name: string; version: number; count: number };
  promptBlocks?: Array<{ name: string; version: number; scope: string; chars: number }>;
  /** False when saved blocks are the whole prompt (no scene was sent). */
  promptScene?: boolean;
  delivery?: ImageDelivery;
  /** Flux edits stop at the router after this many seconds today. */
  editTimeoutSeconds?: number;
  /** A job this attempt is waiting on (contract section 4). */
  jobId?: string;
}
export interface DeliveredImage { width?: number; height?: number; mime: string; bytes: number; cropped?: boolean;
  /** fit exact: the crop here failed, so the render is delivered as it came. */
  cropFailed?: boolean }
export interface GeneratedImageMetadata extends ImageOperationDetails {
  reportedModel?: string; upstreamProvider?: string;
  /** Images of a multi-image render over the kept cap: named, not kept. */
  notKept?: Array<{ index: number; bytes: number }>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
  /** The real pixels of each published image, read from its own header. */
  delivered?: DeliveredImage[];
  /** Which of several images this record is (0-based), when count > 1. */
  imageIndex?: number;
  /** The facts in one plain line, for the bot. */
  summary?: string;
}
/** What the approval card holds: the full assembled prompt, exactly as sent. */
export interface ImageApprovalCardInput { prompt: string; negativePrompt?: string }
export interface ImageGenerationHooks<T> {
  signal?: AbortSignal;
  /** Must check current bot/thread/generation/owner authorization synchronously. */
  assertActive: () => void;
  /** Root owns durable permission/count admission; details contain no credentials. */
  reserve: (details: ImageOperationDetails, card?: ImageApprovalCardInput) => Promise<{ finish: (outcome: ImageAttemptOutcome) => void | Promise<void> }>;
  /** Root must revalidate authority atomically with its owned artifact commit. Called once per image. */
  publish: (image: DecodedGeneratedImage, metadata: GeneratedImageMetadata) => Promise<T>;
  /** The operation's stable id: the Idempotency-Key sent to Flux is its sha256. */
  operationId?: string;
  /** A job an earlier call of this same request started: poll it, never render again. */
  resumeJob?: { id: string };
  /** Must durably record the job id before the first poll. */
  jobStarted?: (job: { id: string }) => void;
  /** The connection's redacted Settings label, for the card. */
  connectionLabel?: string;
}
/** Phase 2 seam: saved prompt blocks go before the scene, reference-pack
 * images before the attached references. Both count against the model. */
export interface ImagePromptAssembly {
  blocks?: Array<{ name: string; version: number; scope: string; text: string }>;
  referencePack?: { name: string; version: number; count: number };
  /** A job being collected: the block versions its kept prompt was built from, for the result. */
  keptBlocks?: Array<{ name: string; version: number; scope: string; chars: number }>;
}
export class ImageGenerationError extends Error {
  readonly code: string;
  readonly outcome: ImageAttemptOutcome;
  readonly correctablePreflight: boolean;
  constructor(code: string, message: string, outcome: ImageAttemptOutcome = "not-dispatched", correctablePreflight = false) { super(message); this.code = code; this.outcome = outcome; this.correctablePreflight = correctablePreflight; }
}
const LOCAL_PREFLIGHT_CODES = new Set(["invalid-request", "invalid-references", "model-required", "unsupported-model", "unsupported-edit", "unsupported-quality", "unsupported-size", "unsupported-parameter", "prompt-too-long", "connection-unavailable"]);
/** What a running render must not see change: the image settings, less the
 * owner's daily-check preference (ticking it never stops a paid render). */
export function imageSettingsIdentity(settings: object | undefined): string {
  const { dailyProbe: _dailyProbe, ...rest } = (settings ?? {}) as Record<string, unknown>;
  return JSON.stringify(rest);
}
/** How long a stream may be silent: OpenAI sends no keepalive and has no edge in between. */
export const streamIdleMs = (provider: ImageProvider, keepaliveSeconds?: number) => provider === "openai" ? BUFFERED_DEADLINE_MS : idleTimeoutMs(keepaliveSeconds);
/** Refusals decided from the model's own statement once its catalogue is read. */
const CATALOGUE_CHECK_CODES = new Set(["prompt-too-long", "unsupported-parameter", "unsupported-size", "unsupported-quality"]);
/** One provider answer is never held past this, whatever n is. */
export const IMAGE_RESPONSE_MAX_BYTES = 128 * 1024 * 1024;
/** Every image as base64 at the generated-image cap, plus room for the JSON
 * around it, within the fixed whole-answer cap. */
export const imageResponseCap = (count: number) => Math.min(IMAGE_RESPONSE_MAX_BYTES, count * (Math.ceil(GENERATED_IMAGE_RECEIVE_MAX_BYTES / 3) * 4 + 64 * 1024) + 1024 * 1024);
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
/** Bounds the checks before the owner's approval; the render has its own limits after it. */
const PREFLIGHT_TIMEOUT_MS = 180_000;
const ENDPOINT_TIMEOUT_MS = 15_000;
const FLUX_CATALOGUE_URL = "https://api.fluxrouter.ai/v1/images/models";
const FLUX_JOBS_URL = "https://api.fluxrouter.ai/v1/images/jobs";
/** Free: the model ids this key may use. Read only on the list and Settings paths. */
const FLUX_MODELS_URL = "https://api.fluxrouter.ai/v1/models";
/** A model check (A.8): the smallest render a model takes. Its bytes are discarded. */
export const IMAGE_PROBE_PROMPT = "A plain grey square.";
/** Contract section 1: at most once per 6 hours per key; a failed read is retried sooner. */
const FLUX_CATALOGUE_TTL_MS = 6 * 60 * 60_000;
const FLUX_CATALOGUE_RETRY_MS = 30 * 60_000;
const REFERENCE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
/** Gemini API image models (Nano Banana), checked 2026-09-28 against
 * https://ai.google.dev/gemini-api/docs/image-generation and
 * https://ai.google.dev/gemini-api/docs/models. All three take text plus
 * reference images in one request, so all three edit. Imagen 4 is shut down
 * on the Gemini API and is not offered. */
const GOOGLE_MODELS = [
  { id: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image" },
  { id: "gemini-3.1-flash-lite-image", label: "Gemini 3.1 Flash Lite Image" },
  { id: "gemini-3-pro-image", label: "Gemini 3 Pro Image" },
];
const GOOGLE_API = "https://generativelanguage.googleapis.com/v1beta/models";
/** The only origin each provider's key may be sent to. */
const PROVIDER_ORIGINS: Record<ImageProvider, string> = {
  openai: "https://api.openai.com", flux: "https://api.fluxrouter.ai", openrouter: "https://openrouter.ai", xai: "https://api.x.ai",
  google: "https://generativelanguage.googleapis.com",
};
/** Google's URL names the model, so it is built per request in serializeImageRequest. */
const URLS: Record<ImageProvider, string> = {
  openai: "https://api.openai.com/v1/images/generations", flux: "https://api.fluxrouter.ai/v1/images/generations",
  openrouter: "https://openrouter.ai/api/v1/images", xai: "https://api.x.ai/v1/images/generations", google: GOOGLE_API,
};
/** Providers with an implemented reference-edit transport. */
const EDIT_URLS: Partial<Record<ImageProvider, string>> = {
  openai: "https://api.openai.com/v1/images/edits", xai: "https://api.x.ai/v1/images/edits", openrouter: "https://openrouter.ai/api/v1/images",
  flux: "https://api.fluxrouter.ai/v1/images/edits", google: GOOGLE_API,
};
/** OpenRouter models admitted for reference edits, each pinned to one upstream endpoint. */
const OPENROUTER_EDIT_ENDPOINTS: Readonly<Record<string, string>> = { "openai/gpt-image-2": "openai" };
const OPENROUTER_EDIT_REASON = "Reference editing is not enabled for this OpenRouter model.";
const OPENROUTER_EDIT_UNVERIFIED = "Reference editing could not be verified on this model's pinned endpoint.";
const CREATES_ONLY = "This model only creates images; it does not edit references.";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function fail(code: string, message: string, outcome?: ImageAttemptOutcome): never { throw new ImageGenerationError(code, message, outcome); }
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const fmt = (value: number) => value.toLocaleString("en-US");
const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function values(parameters: unknown, name: string): string[] {
  if (!record(parameters) || !record(parameters[name])) return [];
  return strings(parameters[name].values);
}
function rasterFormat(parameters: unknown): ImageModelOption["outputFormat"] {
  const formats = values(parameters, "output_format");
  return (["png", "jpeg", "webp"] as const).find(format => formats.includes(format));
}
const pinnedEditTag = (modelId: string): string | undefined => Object.hasOwn(OPENROUTER_EDIT_ENDPOINTS, modelId) ? OPENROUTER_EDIT_ENDPOINTS[modelId] : undefined;
/**
 * Refuses to attach a provider key to any URL outside that provider's own
 * origin. Routing a non-OpenAI key to the OpenAI edit transport fails here.
 */
export function assertCredentialOrigin(provider: ImageProvider, url: string): void {
  let origin = "";
  try { const parsed = new URL(url); if (parsed.protocol === "https:" && !parsed.username && !parsed.password) origin = parsed.origin; } catch { /* invalid URL stays empty */ }
  if (!Object.hasOwn(PROVIDER_ORIGINS, provider) || origin !== PROVIDER_ORIGINS[provider]) fail("credential-origin-mismatch", "The image request did not match its connection's provider, so no key was sent.");
}
/** `: <code>: <message>` from a 4xx JSON error body, or "" when the body is
 * not that shape. Bounded and secret-redacted; never the raw body. */
async function providerErrorDetail(response: Response): Promise<string> {
  try {
    // Bounded as it is read: a chunked error body has no length to check first.
    const body = await boundedJson(response, 64 * 1024);
    const error = record(body) && record(body.error) ? body.error : record(body) ? body : null;
    if (!error) return "";
    const clean = (value: unknown, max: number) => typeof value === "string" && value.trim() ? redactSecretsInText(value.replace(/\s+/g, " ").trim()).slice(0, max) : "";
    const code = clean(error.code, 80), message = clean(error.message, 300);
    if (!code && !message) return "";
    return `: ${[code, message].filter(Boolean).join(": ")}`;
  } catch { return ""; }
}

/** Plain words for a request that never got a reply. Reads the wall the
 * transport hit (DNS, a refused socket, a deadline, TLS) out of whatever the
 * fetch stack threw.
 *
 * Only these fixed phrases are ever returned. A thrown error's own text can
 * carry the request URL, a header or a key, so it is matched against and
 * never echoed; an unrecognized failure keeps the plain sentence it always
 * had rather than repeating something private back to the screen. */
const TRANSPORT_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/, "its address could not be looked up"],
  [/ECONNREFUSED/, "it refused the connection"],
  [/ETIMEDOUT|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|TimeoutError/, "it did not answer in time"],
  [/ECONNRESET|EPIPE|SOCKET|ERR_STREAM_PREMATURE/, "the connection dropped before the image arrived"],
  [/CERT|TLS|SSL|EPROTO|SELF_SIGNED|UNABLE_TO_VERIFY/, "a secure connection could not be established"],
  [/ENETUNREACH|EHOSTUNREACH|ENETDOWN/, "there is no route to it from this computer"],
  [/redirect|ERR_FR_REDIRECTION|ERR_TOO_MANY_REDIRECTS/i, "it redirected the request somewhere that could not be followed"],
  [/AbortError/, "the request was stopped before it answered"],
];
export function describeTransportFailure(error: unknown): { code: string; message: string } {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  for (let node: unknown = error, depth = 0; node && depth < 5; depth++) {
    if (typeof node !== "object" || seen.has(node)) break;
    seen.add(node);
    const value = node as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    for (const field of [value.name, value.code, value.message]) if (typeof field === "string") parts.push(field);
    node = value.cause ?? (Array.isArray(value.errors) ? value.errors[0] : undefined);
  }
  const known = TRANSPORT_REASONS.find(([pattern]) => pattern.test(parts.join(" ")))?.[1];
  return known
    ? { code: "provider-unreachable", message: `The image provider could not be reached: ${known}.` }
    : { code: "request-failed", message: "Image generation could not complete." };
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) { void response.body?.cancel(); fail("oversized-response", "The image provider response was too large.", "uncertain"); }
  if (!response.body) fail("invalid-response", "The image provider returned no response.", "uncertain");
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > limit) { await reader.cancel(); fail("oversized-response", "The image provider response was too large.", "uncertain"); } chunks.push(next.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof ImageGenerationError) throw error; return fail("invalid-response", "The image provider returned an unreadable response.", "uncertain"); }
  finally { reader.releaseLock(); }
}
/** OpenRouter advertises the reference count an endpoint accepts as `{type:"range",min,max}`. */
function referenceRange(parameters: unknown): { min: number; max: number } | null {
  if (!record(parameters) || !record(parameters.input_references)) return null;
  const { type, min, max } = parameters.input_references;
  if (type !== "range" || typeof min !== "number" || typeof max !== "number" || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < 1 || max < min) return null;
  return { min, max };
}
interface EndpointMatch { modelId: string; outputFormat: ImageModelOption["outputFormat"]; quality?: string; size?: string }
function endpointRows(info: unknown): Array<{ tag: string; parameters: unknown }> {
  const endpoints = record(info) && Array.isArray(info.endpoints) ? info.endpoints : [];
  return endpoints.flatMap(item => record(item) && typeof item.provider_tag === "string" && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,119}$/.test(item.provider_tag)
    ? [{ tag: item.provider_tag, parameters: item.supported_parameters }] : []);
}
function rasterCompatible(parameters: unknown, match: EndpointMatch): boolean {
  return (rasterFormat(parameters) === match.outputFormat || (match.modelId === "openai/gpt-image-2" && values(parameters, "output_format").length === 0))
    && (!match.quality || values(parameters, "quality").includes(match.quality)) && (!match.size || values(parameters, "size").includes(match.size));
}
/**
 * The pinned endpoint's reference-edit capability. Absent, malformed or
 * incompatible records return null. The endpoint's range can lower Murage's
 * shared cap but never raise it.
 */
function pinnedEditCapability(info: unknown, match: EndpointMatch): { tag: string; minReferences: number; maxReferences: number } | null {
  const tag = pinnedEditTag(match.modelId);
  const endpoint = tag ? endpointRows(info).find(row => row.tag === tag) : undefined;
  if (!tag || !endpoint || !rasterCompatible(endpoint.parameters, match)) return null;
  const range = referenceRange(endpoint.parameters);
  if (!range) return null;
  const minReferences = Math.max(1, range.min), maxReferences = Math.min(IMAGE_GENERATION_REFERENCE_MAX, range.max);
  return minReferences <= maxReferences ? { tag, minReferences, maxReferences } : null;
}
/** The older `sizes` list, for views that predate `capabilities`. */
function legacySizes(capabilities: ImageModelCapabilities): string[] {
  return capabilities.sizeRule.kind === "list" ? [...capabilities.sizeRule.sizes] : [];
}
function modelOption(id: string, label: string, capabilities: ImageModelCapabilities, extra: Partial<ImageModelOption> = {}): ImageModelOption {
  const edit = capabilities.supports.edit;
  return { id, label, generate: true, edit, maxReferences: edit ? capabilities.maxReferences : 0, availability: "unverified",
    qualities: [...capabilities.qualities], sizes: legacySizes(capabilities), outputFormat: capabilities.formats[0] ?? "png", capabilities,
    ...(edit ? {} : { editUnavailableReason: CREATES_ONLY }), ...extra };
}
/** Normalize only a dedicated image catalog; unknown/vector output remains disabled. */
export function parseOpenRouterImageCatalog(payload: unknown): ImageModelOption[] {
  if (!record(payload) || !Array.isArray(payload.data) || payload.data.length > 1000) fail("invalid-catalog", "The image catalog was invalid or too large.");
  const seen = new Set<string>(); const models: ImageModelOption[] = [];
  for (const row of payload.data as unknown[]) {
    if (!record(row) || typeof row.id !== "string" || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9][A-Za-z0-9._:-]{0,140}$/.test(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    if (!record(row.architecture) || !strings(row.architecture.output_modalities).includes("image")) continue;
    const format = rasterFormat(row.supported_parameters);
    const documentedGpt2 = row.id === "openai/gpt-image-2" && values(row.supported_parameters, "output_format").length === 0;
    const video = strings(row.architecture.output_modalities).includes("video");
    const generate = !video && Boolean(format || documentedGpt2);
    const qualities = values(row.supported_parameters, "quality"), sizes = values(row.supported_parameters, "size");
    const outputFormat = format ?? (documentedGpt2 ? "png" : undefined);
    models.push({ id: row.id, label: typeof row.name === "string" ? row.name.slice(0, 120) : row.id,
      generate, edit: false, maxReferences: 0, availability: "catalog-listed",
      editUnavailableReason: generate && pinnedEditTag(row.id) ? OPENROUTER_EDIT_UNVERIFIED : OPENROUTER_EDIT_REASON,
      ...(video || (!format && !documentedGpt2) ? { disabledReason: "A supported raster output format is not advertised by this adapter." } : {}),
      outputFormat, qualities, sizes, capabilities: openRouterCapabilities(row.id, sizes, qualities, 0, outputFormat),
    });
  }
  return models;
}
function staticCatalog(connection: ImageConnection): ImageCatalog {
  const base = { connectionId: connection.id, provider: connection.provider };
  if (connection.provider === "openai") return { ...base, defaultModel: "gpt-image-2", models: OPENAI_IMAGE_MODELS.map(id => modelOption(id, id, builtInImageCapabilities("openai", id)!)) };
  if (connection.provider === "flux") return { ...base, defaultModel: "flux-image", capabilitySource: "built-in",
    models: fluxBuiltInModels().map(model => modelOption(model.id, model.label, model.capabilities, model.aliasOf ? { aliasOf: model.aliasOf } : {})) };
  if (connection.provider === "google") return { ...base, defaultModel: GOOGLE_MODELS[0]!.id, models: GOOGLE_MODELS.map(model => modelOption(model.id, model.label, builtInImageCapabilities("google", model.id)!)) };
  if (connection.provider === "xai") return { ...base, defaultModel: null, models: [modelOption("grok-imagine-image-2.0", "Grok Imagine Image 2.0", builtInImageCapabilities("xai", "grok-imagine-image-2.0")!, { editQualities: [] })] };
  return { ...base, defaultModel: "openai/gpt-image-2", models: [] };
}
/** The Flux rows with a catalogue: its entries first, each alias as a row of
 * its own, and every built-in id the catalogue does not mention kept so an
 * older saved choice still resolves. */
function fluxCatalogFrom(connection: ImageConnection, catalogue: FluxCatalogue): ImageCatalog {
  const rows: ImageModelOption[] = [];
  const seen = new Set<string>();
  // An older id always keeps the one quality and size it has always meant;
  // the catalogue can only tell Murage about its references and delivery.
  const pinned = (id: string, from: ImageModelCapabilities): ImageModelCapabilities | null => {
    const legacy = FLUX_LEGACY_IDS[id] && !FLUX_FAMILY_IDS.has(id) ? builtInImageCapabilities("flux", id) : null;
    return legacy ? { ...legacy, maxReferences: from.maxReferences, maxReferenceBytes: from.maxReferenceBytes, maxReferenceBytesTotal: from.maxReferenceBytesTotal, delivery: from.delivery, source: "catalogue" } : null;
  };
  for (const entry of catalogue.entries) {
    const status = entry.status ? { status: entry.status } : {};
    const legacy = pinned(entry.id, entry.capabilities);
    rows.push(modelOption(entry.id, entry.label, legacy ?? entry.capabilities, { availability: "catalog-listed", ...status, ...(legacy ? { aliasOf: FLUX_LEGACY_IDS[entry.id]!.base } : {}) }));
    seen.add(entry.id);
  }
  for (const entry of catalogue.entries) for (const alias of entry.aliases) {
    if (seen.has(alias)) continue;
    rows.push(modelOption(alias, alias, pinned(alias, entry.capabilities) ?? entry.capabilities, { availability: "catalog-listed", aliasOf: entry.id }));
    seen.add(alias);
  }
  for (const model of staticCatalog(connection).models) if (!seen.has(model.id)) rows.push(model);
  return { connectionId: connection.id, provider: "flux", defaultModel: catalogue.defaultModel ?? "flux-image", capabilitySource: "catalogue", models: rows };
}
const dataUrl = (reference: ImageReference) => `data:${reference.mime};base64,${reference.bytes.toString("base64")}`;
/**
 * Chooses the provider-specific transport after shared validation. The key is
 * not part of the result; it is attached only at dispatch, after
 * assertCredentialOrigin has accepted this URL.
 */
function serializeImageRequest(provider: ImageProvider, operation: "generate" | "edit", payload: Record<string, unknown>, references: readonly ImageReference[]): { url: string; body: string | FormData; headers: Record<string, string> } {
  if (provider === "google") {
    // generateContent: the prompt and any references as parts of one user
    // turn, asking for an image back. The model id was matched against the
    // static catalog before this point, so it is fine in the path.
    const parts: unknown[] = [{ text: payload.prompt }, ...references.map(reference => ({ inline_data: { mime_type: reference.mime, data: reference.bytes.toString("base64") } }))];
    const imageConfig = { ...(typeof payload.aspect_ratio === "string" ? { aspectRatio: payload.aspect_ratio } : {}), imageSize: typeof payload.image_size === "string" ? payload.image_size : "1K" };
    const body = { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE"], imageConfig, ...(typeof payload.seed === "number" ? { seed: payload.seed } : {}) } };
    return { url: `${GOOGLE_API}/${encodeURIComponent(String(payload.model))}:generateContent`, body: JSON.stringify(body), headers: { "content-type": "application/json" } };
  }
  if (operation === "generate") return { url: URLS[provider], body: JSON.stringify(payload), headers: { "content-type": "application/json" } };
  const url = EDIT_URLS[provider];
  if (!url) return fail("unsupported-edit", "Editing is not supported on this image connection.");
  if (provider === "openai" || provider === "flux") {
    const form = new FormData(); for (const [key, value] of Object.entries(payload)) form.append(key, String(value));
    for (let index = 0; index < references.length; index++) { const reference = references[index]!; form.append("image[]", new Blob([new Uint8Array(reference.bytes)], { type: reference.mime }), `reference-${index}.${reference.mime === "image/jpeg" ? "jpg" : reference.mime.slice(6)}`); }
    return { url, body: form, headers: {} };
  }
  // xAI: JSON edits. One input uses `image`, two or more use `images`; never both.
  // OpenRouter: JSON `input_references` on its existing images endpoint.
  const body = provider === "xai"
    ? { ...payload, ...(references.length === 1 ? { image: { type: "image_url", url: dataUrl(references[0]!) } } : { images: references.map(reference => ({ type: "image_url", url: dataUrl(reference) })) }) }
    : { ...payload, input_references: references.map(reference => ({ type: "image_url", image_url: { url: dataUrl(reference) } })) };
  return { url, body: JSON.stringify(body), headers: { "content-type": "application/json" } };
}
/** The one image a Gemini generateContent reply carries, as base64. More
 * than one image, or none (a refusal comes back as text only), is not a
 * supported result. */
function googleImageData(result: unknown): string | undefined {
  if (!record(result) || !Array.isArray(result.candidates) || !record(result.candidates[0]) || !record(result.candidates[0].content)) return undefined;
  const parts = Array.isArray(result.candidates[0].content.parts) ? result.candidates[0].content.parts : [];
  const images = parts.flatMap(part => {
    const inline = record(part) ? part.inlineData ?? part.inline_data : undefined;
    return record(inline) && typeof inline.data === "string" ? [inline.data] : [];
  });
  return images.length === 1 ? images[0] : undefined;
}
/** Why a Gemini reply carried no image, in plain words: the provider's own
 * reason code passed through verbatim (codes only), or a short bounded,
 * redacted piece of the text it sent instead. */
function googleNoImageReason(result: unknown): string {
  const code = (value: unknown) => typeof value === "string" && /^[A-Z][A-Z_]{0,39}$/.test(value) ? value : undefined;
  const base = "Gemini did not return an image";
  if (!record(result)) return `${base}.`;
  const blocked = record(result.promptFeedback) ? code(result.promptFeedback.blockReason) : undefined;
  if (blocked) return `${base}: it blocked the request (reason: ${blocked}).`;
  const candidate = Array.isArray(result.candidates) && record(result.candidates[0]) ? result.candidates[0] : undefined;
  const finish = code(candidate?.finishReason);
  if (finish && finish !== "STOP") return `${base}: it stopped the render (reason: ${finish}).`;
  const parts = candidate && record(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const text = parts.map(part => record(part) && typeof part.text === "string" ? part.text : "").join(" ").replace(/\s+/g, " ").trim();
  if (text) { const short = redactSecretsInText(text).replace(/[<>]/g, "").slice(0, 200); return `${base}. It replied: "${short}${text.length > 200 ? "..." : ""}"`; }
  return `${base}.`;
}
function safeUsage(payload: Record<string, unknown>): GeneratedImageMetadata["usage"] {
  if (!record(payload.usage)) return undefined;
  const usage = payload.usage; const result: NonNullable<GeneratedImageMetadata["usage"]> = {};
  for (const [output, names] of [["inputTokens", ["input_tokens", "prompt_tokens"]], ["outputTokens", ["output_tokens", "completion_tokens"]], ["totalTokens", ["total_tokens"]], ["costUsd", ["cost"]]] as const) {
    const value = names.map(name => usage[name]).find(item => typeof item === "number" && Number.isFinite(item) && item >= 0);
    if (typeof value === "number") result[output] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
/** Up to three other models on this connection that pass `accepts`, by id. */
function otherModels(catalog: ImageCatalog, current: string, edit: boolean, accepts: (capabilities: ImageModelCapabilities) => boolean): string[] {
  return catalog.models.filter(model => model.id !== current && model.generate && !model.disabledReason && !model.aliasOf && (!edit || model.edit) && accepts(model.capabilities)).map(model => model.id).slice(0, 3);
}
const orChoose = (models: string[], none: string) => models.length ? `choose ${models.join(", ")}` : none;

/** The size facts in one sentence, for the card ("will be") or the result. */
function sizeSentence(details: ImageOperationDetails, deliveredPixels?: string): string {
  const rendered = deliveredPixels ?? details.sizeRendered ?? details.size;
  if (!rendered) return "";
  const asked = details.sizeAsked && details.sizeAsked !== "default" ? `${details.sizeAsked} asked, ` : "";
  const crop = details.cropTo ? `, cropped and resized here to ${details.cropTo}` : "";
  if (!asked && !crop) return deliveredPixels ? `${deliveredPixels} delivered.` : "";
  return `${asked}${rendered} rendered${crop}.`;
}
/** The approval card's subtitle: every fact the owner approves, no cost. */
export function imageApprovalSubtitle(details: ImageOperationDetails): string {
  const count = details.count === 1 ? "One image" : `${details.count} images`;
  const refs = details.referenceCount ? ` from ${details.referenceCount === 1 ? "1 reference image" : `${details.referenceCount} reference images`}` : "";
  const sent = details.sentModel && details.sentModel !== details.model ? ` (sent as ${details.sentModel})` : "";
  const pinned = details.endpointTag ? ` (pinned to ${details.endpointTag}, no fallback)` : "";
  // A named connection's id is `model:<uuid>`: the card names it the way Settings does.
  const connection = details.connectionLabel ?? (details.connectionId.startsWith("model:") ? details.provider : details.connectionId);
  const lines = [`${count}${refs} · ${connection} · ${details.model}${sent}${pinned}${details.quality ? ` · ${details.quality}` : ""}${details.size ? ` · ${details.size}` : ""}.`];
  const size = sizeSentence(details); if (size) lines.push(size);
  if (details.experimentalSize) lines.push("That size is experimental on this model.");
  if (details.referenceCap !== undefined && (details.referenceCount || details.referencePack)) {
    const pack = details.referencePack;
    lines.push(pack ? `References: ${pack.count} from pack ${pack.name} v${pack.version} + ${details.referenceCount - pack.count} attached = ${details.referenceCount} of ${details.referenceCap}.` : `References: ${details.referenceCount} of ${details.referenceCap}.`);
  }
  if (details.promptChars !== undefined) {
    const blocks = details.promptBlocks?.length ? `: ${details.promptBlocks.map(block => `${block.name} v${block.version}`).join(" + ")}${details.promptScene === false ? "" : " + scene"}` : "";
    lines.push(`Prompt: ${fmt(details.promptChars)} characters${blocks}.`);
  }
  if (details.condensedFromChars !== undefined && details.promptChars !== undefined) lines.push(`Condensed from ${fmt(details.condensedFromChars)} to ${fmt(details.promptChars)} characters for ${details.model}.`);
  if (details.avoidLine) lines.push("Negative prompt added as an Avoid: line.");
  if (details.negativeChars) lines.push(`Negative prompt sent in its own field: ${fmt(details.negativeChars)} characters.`);
  if (details.outputFormat) lines.push(`Format: ${details.outputFormat}${details.outputCompression !== undefined ? `, compression ${details.outputCompression}` : ""}.`);
  if (details.background) lines.push("Transparent background.");
  if (details.seed !== undefined) lines.push(`Seed ${details.seed}.`);
  if (details.editTimeoutSeconds) lines.push(`Edits through Flux stop after about ${details.editTimeoutSeconds} seconds.`);
  return lines.join(" ");
}
const pixelsOf = (image: DeliveredImage) => image.width && image.height ? `${image.width}x${image.height}` : undefined;
/** The delivered size in one sentence, from the images' own headers. */
export function imageDeliveredSentence(metadata: GeneratedImageMetadata): string {
  const delivered = metadata.delivered ?? [];
  const unique = [...new Set(delivered.map(pixelsOf).filter(Boolean) as string[])];
  if (unique.length !== 1) return unique.length ? `${unique.join(", ")} delivered.` : "";
  const cropped = delivered.some(image => image.cropped);
  if (delivered.some(image => image.cropFailed)) {
    const asked = metadata.sizeAsked && metadata.sizeAsked !== "default" ? `${metadata.sizeAsked} asked, ` : "";
    return `${asked}${unique[0]} rendered. It could not be cropped here to ${metadata.cropTo ?? "the exact size"}, so it is delivered as rendered.`;
  }
  // A crop's delivered pixels are the crop; the render is the size sent.
  return cropped ? sizeSentence({ ...metadata, cropTo: unique[0] }) : sizeSentence(metadata, unique[0]);
}
/** The result's facts in one line: real delivered pixels, never assumed. */
export function imageResultSummary(metadata: GeneratedImageMetadata): string {
  const delivered = metadata.delivered ?? [];
  const count = delivered.length === 1 ? "1 image" : `${delivered.length} images${metadata.count > delivered.length ? ` of ${metadata.count} asked` : ""}`;
  const size = imageDeliveredSentence(metadata);
  const facts = [`${count} with ${metadata.model}${metadata.sentModel && metadata.sentModel !== metadata.model ? ` (sent as ${metadata.sentModel})` : ""} through ${metadata.provider}.`, size];
  if (metadata.promptChars !== undefined) facts.push(`Prompt: ${fmt(metadata.promptChars)} characters.`);
  if (metadata.condensedFromChars !== undefined && metadata.promptChars !== undefined) facts.push(`Condensed from ${fmt(metadata.condensedFromChars)} to ${fmt(metadata.promptChars)} characters for ${metadata.model}.`);
  if (metadata.avoidLine) facts.push("Negative prompt added as an Avoid: line.");
  for (const item of metadata.notKept ?? []) facts.push(`Image ${item.index + 1} arrived at ${mib(item.bytes)}, over the ${mib(GENERATED_IMAGE_MAX_BYTES)} Murage keeps, so it was not kept.`);
  return facts.filter(Boolean).join(" ");
}

/** Flux: a model the key's own list names (itself or one of its alias ids)
 * is catalog-listed; one it does not name is marked, never hidden. */
function markOffered(catalog: ImageCatalog, offered: ReadonlySet<string>): ImageCatalog {
  return { ...catalog, models: catalog.models.map(model => {
    const caps = model.capabilities;
    const ids = [model.id, ...Object.values(caps.qualityAliases ?? {}), ...Object.values(caps.sizeAliases ?? {}).flatMap(sizes => Object.values(sizes))];
    if (!ids.some(id => offered.has(id))) return { ...model, offeredToKey: false };
    return { ...model, offeredToKey: true, ...(model.availability === "unverified" ? { availability: "catalog-listed" as const } : {}) };
  }) };
}
export interface ImageProbeResult { ok: boolean; free: boolean; durationMs: number; errorCode?: string; errorMessage?: string; costUsd?: number }

/** What list_image_models hands a bot: every model's own limits, compact.
 * An older alias id is one line naming its base, quality and size (the bot
 * passes quality on the base instead); the router's alias maps stay here. */
export function imageModelsForBots(catalog: ImageCatalog): unknown[] {
  return catalog.models.map(model => {
    const { qualityAliases: _aliases, sizeAliases: _sizes, sizeRule, ...capabilities } = model.capabilities;
    const common = { id: model.id, label: model.label, generate: model.generate, edit: model.edit, availability: model.availability,
      ...(model.lastGoodAt !== undefined ? { lastGoodAt: new Date(model.lastGoodAt).toISOString() } : {}), ...(model.lastFailedAt !== undefined ? { lastFailedAt: new Date(model.lastFailedAt).toISOString() } : {}),
      ...(model.lastError ? { lastError: model.lastError } : {}), ...(model.offeredToKey === false ? { offeredToKey: false } : {}),
      ...(model.status ? { status: model.status } : {}), ...(model.disabledReason ? { disabledReason: model.disabledReason } : {}), ...(model.editUnavailableReason ? { editUnavailableReason: model.editUnavailableReason } : {}) };
    if (model.aliasOf) return { ...common, aliasOf: model.aliasOf, quality: model.qualities[0], sizes: model.sizes };
    return { ...common, capabilities: { ...capabilities, sizeRule, ...(model.editQualities ? { editQualities: model.editQualities } : {}) } };
  });
}

export interface ImageGenerationServiceOptions {
  resolveConnection: (id: string) => ImageConnection | null; connectionIds: () => string[]; fetch?: typeof fetch;
  /** Read Flux's image catalogue (contract section 1). Off unless asked, so a
   * service built for one purpose never reaches the network by surprise. */
  fluxCatalogue?: boolean;
  /** fit exact cropping; defaults to sharp when it loads. */
  crop?: () => Promise<CropImage | null>;
  /** Job polling clock, for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number;
}
export class ImageGenerationService {
  private readonly fetcher: typeof fetch;
  private readonly options: ImageGenerationServiceOptions;
  private readonly fluxCatalogues = new Map<string, { at: number; ttl: number; value: FluxCatalogue | null }>();
  private readonly fluxOffered = new Map<string, { at: number; ttl: number; value: Set<string> | null }>();
  constructor(options: ImageGenerationServiceOptions) { this.options = options; this.fetcher = options.fetch ?? fetch; }
  private connection(id: string): ImageConnection {
    // No connection, or no key on it, means nothing was ever sent and nothing
    // was ever charged. The person fixes it in Settings in five seconds, so
    // this must not spend the turn's one image attempt on the way out.
    const unusable = (message: string): never => { throw new ImageGenerationError("connection-unavailable", message, "not-dispatched", true); };
    let found: ImageConnection | null;
    try { found = this.options.resolveConnection(id); } catch { return unusable("The image connection could not be read. Review it in Settings."); }
    if (!found || found.id !== id || !Object.hasOwn(URLS, found.provider) || !found.apiKey.trim()) unusable("Choose a configured image connection in Settings.");
    return { ...found! };
  }
  /** Public, unauthenticated endpoint record for one OpenRouter model. 15-second bound; every failure fails closed. */
  private async openRouterEndpoints(modelId: string, signal?: AbortSignal): Promise<unknown> {
    const url = `https://openrouter.ai/api/v1/images/models/${modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`;
    const timeout = AbortSignal.timeout(ENDPOINT_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" });
      if (!response.ok) { void response.body?.cancel(); throw new Error("endpoint record unavailable"); }
      return await boundedJson(response, MAX_CATALOG_BYTES);
    } catch { return fail("catalog-unavailable", "Could not verify this image model’s endpoint capabilities."); }
  }
  /** Flux's image catalogue, cached per key revision. Any failure, a 404
   * (today's router) or a body that is not contract 1 means "old router":
   * null, and the built-in table is used without a word to the bot. */
  private async fluxCatalogue(connection: ImageConnection, signal?: AbortSignal, refresh = false): Promise<FluxCatalogue | null> {
    const now = Date.now(), cached = this.fluxCatalogues.get(connection.revision);
    if (!refresh && cached && now - cached.at < cached.ttl) return cached.value;
    let value: FluxCatalogue | null = null, ttl = FLUX_CATALOGUE_TTL_MS;
    try {
      assertCredentialOrigin("flux", FLUX_CATALOGUE_URL);
      const timeout = AbortSignal.timeout(ENDPOINT_TIMEOUT_MS);
      const response = await this.fetcher(FLUX_CATALOGUE_URL, { headers: { authorization: `Bearer ${connection.apiKey}` }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" });
      if (response.ok) value = parseFluxImageCatalogue(await boundedJson(response, MAX_CATALOG_BYTES));
      else { void response.body?.cancel(); if (response.status >= 500 || response.status === 429) ttl = FLUX_CATALOGUE_RETRY_MS; }
    } catch { value = null; ttl = FLUX_CATALOGUE_RETRY_MS; }
    if (signal?.aborted) return value;
    this.fluxCatalogues.set(connection.revision, { at: now, ttl, value });
    return value;
  }
  /** The image model ids Flux lists for this key (free), cached like the
   * catalogue. null when the list could not be read or names no image model:
   * then nothing is marked either way. */
  private async fluxOfferedIds(connection: ImageConnection, signal?: AbortSignal, refresh = false): Promise<Set<string> | null> {
    const now = Date.now(), cached = this.fluxOffered.get(connection.revision);
    if (!refresh && cached && now - cached.at < cached.ttl) return cached.value;
    let value: Set<string> | null = null, ttl = FLUX_CATALOGUE_TTL_MS;
    try {
      assertCredentialOrigin("flux", FLUX_MODELS_URL);
      const timeout = AbortSignal.timeout(ENDPOINT_TIMEOUT_MS);
      const response = await this.fetcher(FLUX_MODELS_URL, { headers: { authorization: `Bearer ${connection.apiKey}` }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" });
      if (response.ok) {
        const body = await boundedJson(response, MAX_CATALOG_BYTES);
        const ids = record(body) && Array.isArray(body.data) ? body.data.flatMap(item => record(item) && typeof item.id === "string" && /^flux-image[a-z0-9._-]{0,110}$/.test(item.id) ? [item.id] : []) : [];
        value = ids.length ? new Set(ids) : null;
      } else { void response.body?.cancel(); ttl = FLUX_CATALOGUE_RETRY_MS; }
    } catch { value = null; ttl = FLUX_CATALOGUE_RETRY_MS; }
    if (signal?.aborted) return value;
    this.fluxOffered.set(connection.revision, { at: now, ttl, value });
    return value;
  }
  listConnections(): Array<{ id: string; provider: ImageProvider; defaultModel: string | null }> {
    // 32 named connections plus the existing default keys.
    return [...new Set(this.options.connectionIds())].slice(0, 40).flatMap(id => {
      try { const connection = this.connection(id); return [{ id, provider: connection.provider, defaultModel: staticCatalog(connection).defaultModel }]; }
      catch { return []; }
    });
  }
  /** The models a connection offers without asking its provider, or null
   * when only the live catalog knows them (OpenRouter). Never the network. */
  localModelIds(connectionId: string): string[] | null {
    const connection = this.connection(connectionId);
    return connection.provider === "openrouter" ? null : staticCatalog(connection).models.filter(model => model.generate && !model.disabledReason).map(model => model.id);
  }
  /**
   * `discoverEdits` (default true) checks each admitted OpenRouter edit model's
   * pinned endpoint. A failed check keeps generation and shows editing unavailable.
   * `refresh` rereads the Flux catalogue now (the owner's Refresh).
   */
  async getCatalog(connectionId: string, options: { signal?: AbortSignal; discoverEdits?: boolean; refresh?: boolean; offered?: boolean } = {}): Promise<ImageCatalog> {
    const { signal, discoverEdits = true } = options;
    const connection = this.connection(connectionId); const catalog = staticCatalog(connection);
    if (connection.provider === "flux") {
      if (!this.options.fluxCatalogue) return catalog;
      const catalogue = await this.fluxCatalogue(connection, signal, options.refresh);
      const full = catalogue?.entries.length ? fluxCatalogFrom(connection, catalogue) : catalog;
      // `offered` is asked only by the list and Settings paths, never by a render.
      const offered = options.offered ? await this.fluxOfferedIds(connection, signal, options.refresh) : null;
      return offered ? markOffered(full, offered) : full;
    }
    if (connection.provider !== "openrouter") return catalog;
    const response = await this.fetcher("https://openrouter.ai/api/v1/images/models", { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) fail("catalog-unavailable", "Could not refresh the image model catalog. Try again later.");
    const models = parseOpenRouterImageCatalog(await boundedJson(response, MAX_CATALOG_BYTES));
    if (discoverEdits) {
      for (const model of models) {
        if (!model.generate || model.disabledReason || !pinnedEditTag(model.id)) continue;
        let capability: ReturnType<typeof pinnedEditCapability> = null;
        try { capability = pinnedEditCapability(await this.openRouterEndpoints(model.id, signal), { modelId: model.id, outputFormat: model.outputFormat }); } catch { capability = null; }
        if (capability) {
          model.edit = true; model.maxReferences = capability.maxReferences; delete model.editUnavailableReason;
          model.capabilities = { ...model.capabilities, maxReferences: capability.maxReferences, supports: { ...model.capabilities.supports, edit: true } };
        }
      }
    }
    return { ...catalog, models };
  }
  /**
   * One owner-started or scheduled check of a model (A.8). Uses Flux's free
   * probe when its catalogue says it has one; otherwise one real render at the
   * lowest quality and smallest legal square, never published, bytes
   * discarded, never retried. Failures are the result, not a throw.
   */
  async probe(connectionId: string, modelId: string, options: { signal?: AbortSignal } = {}): Promise<ImageProbeResult> {
    const now = this.options.now ?? Date.now, started = now();
    const done = (result: Omit<ImageProbeResult, "durationMs">): ImageProbeResult => ({ ...result, durationMs: Math.max(0, now() - started) });
    try {
      const connection = this.connection(connectionId);
      if (connection.provider === "flux" && this.options.fluxCatalogue && (await this.fluxCatalogue(connection, options.signal))?.probe) {
        const url = URLS.flux;
        assertCredentialOrigin("flux", url);
        const timeout = AbortSignal.timeout(ENDPOINT_TIMEOUT_MS);
        const response = await this.fetcher(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${connection.apiKey}` },
          body: JSON.stringify({ model: modelId, probe: true }), signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout, redirect: "error" });
        if (!response.ok) return done({ ok: false, free: true, errorCode: "provider-error", errorMessage: `Flux answered HTTP ${response.status}${await providerErrorDetail(response)}.` });
        const body = await boundedJson(response, 64 * 1024);
        if (!record(body) || body.contract !== 1 || body.kind !== "image-probe" || !["ok", "down"].includes(String(body.state))) return done({ ok: false, free: true, errorCode: "invalid-response", errorMessage: "Flux's check answer was not understood." });
        const detail = typeof body.detail === "string" ? redactSecretsInText(body.detail.replace(/\s+/g, " ").trim()).slice(0, 300) : "";
        return body.state === "ok" ? done({ ok: true, free: true }) : done({ ok: false, free: true, errorCode: "down", errorMessage: detail || "Flux reports this model is down." });
      }
      const catalog = await this.getCatalog(connectionId, { signal: options.signal, discoverEdits: false });
      const model = catalog.models.find(item => item.id === modelId);
      if (!model?.generate || model.disabledReason) return done({ ok: false, free: false, errorCode: "unsupported-model", errorMessage: "This model is not available for image generation here." });
      const caps = model.capabilities;
      const quality = IMAGE_QUALITIES.find(item => caps.qualities.includes(item));
      const square = resolveImageSize(caps.sizeRule, { aspectRatio: "1:1", resolution: "small" }, caps.defaultSize);
      const request = { connectionId, model: modelId, prompt: IMAGE_PROBE_PROMPT, n: 1, ...(quality ? { quality } : {}), ...(square.ok ? { aspectRatio: "1:1", resolution: "small" as const } : {}) };
      const result = await this.generate<number>(request, { signal: options.signal, assertActive: () => {}, reserve: async () => ({ finish: () => {} }), publish: async image => image.bytes.length });
      const costUsd = result.metadata.usage?.costUsd;
      return done({ ok: true, free: false, ...(costUsd !== undefined ? { costUsd } : {}) });
    } catch (error) {
      if (error instanceof ImageGenerationError) return done({ ok: false, free: false, errorCode: error.code, errorMessage: error.message });
      const transport = describeTransportFailure(error);
      return done({ ok: false, free: false, errorCode: transport.code, errorMessage: transport.message });
    }
  }
  async generate<T>(raw: unknown, hooks: ImageGenerationHooks<T>, references: readonly ImageReference[] = [], assembly: ImagePromptAssembly = {}): Promise<{ artifact: T; artifacts: T[]; metadata: GeneratedImageMetadata }> {
    const parsed = imageGenerationRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const field = parsed.error!.issues[0]?.path.join(".");
      throw new ImageGenerationError("invalid-request", `Choose a connection, a supported model and a prompt of at most ${fmt(IMAGE_PROMPT_HARD_MAX)} characters${field ? ` (check ${field})` : ""}. URLs and keys are not accepted.`, "not-dispatched", true);
    }
    const request = parsed.data!; const connection = this.connection(request.connectionId);
    if ((assembly.blocks?.length ?? 0) > IMAGE_PROMPT_BLOCKS_MAX) throw new ImageGenerationError("invalid-request", `One image request takes at most ${IMAGE_PROMPT_BLOCKS_MAX} prompt blocks. Nothing was sent.`, "not-dispatched", true);
    if (!request.prompt && !assembly.blocks?.length) throw new ImageGenerationError("invalid-request", "Send a prompt, saved prompt_blocks, or both. Nothing was sent.", "not-dispatched", true);
    let signal = hooks.signal ? AbortSignal.any([hooks.signal, AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS)]) : AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS);
    let outcome: ImageAttemptOutcome = "not-dispatched"; let reservation: Awaited<ReturnType<ImageGenerationHooks<T>["reserve"]>> | undefined;
    let reservationStarted = false, externalReadStarted = false;
    const active = () => {
      if (signal.aborted) fail("cancelled", "Image generation was cancelled. No automatic retry was attempted.", outcome);
      try { hooks.assertActive(); } catch { fail("not-authorized", "This image request is no longer authorized.", outcome); }
      const current = this.options.resolveConnection(connection.id);
      if (!current || current.provider !== connection.provider || current.revision !== connection.revision || current.apiKey !== connection.apiKey) fail("connection-changed", "The image connection changed. Review it before trying again.", outcome);
    };
    try {
      active();
      const totalBytes = references.reduce((sum, item) => sum + item.bytes.length, 0);
      if (references.length > IMAGE_GENERATION_REFERENCE_MAX) fail("invalid-references", `${references.length} reference images; Murage takes at most ${IMAGE_GENERATION_REFERENCE_MAX}. Nothing was sent.`);
      if (totalBytes > IMAGE_GENERATION_REFERENCE_MAX_TOTAL_BYTES) fail("invalid-references", `Reference images must total at most ${mib(IMAGE_GENERATION_REFERENCE_MAX_TOTAL_BYTES)}. Nothing was sent.`);
      for (const reference of references) {
        if (!Buffer.isBuffer(reference.bytes) || !reference.bytes.length || reference.bytes.length > GENERATED_IMAGE_MAX_BYTES || !REFERENCE_MIMES.includes(reference.mime)) fail("invalid-references", "Reference images must be bounded PNG, JPEG or WebP files.");
        try { if (decodeGeneratedImage(reference.bytes.toString("base64")).mime !== reference.mime) throw new Error("format mismatch"); }
        catch { fail("invalid-references", "A reference image has an invalid format."); }
      }
      const edit = request.operation === "edit";
      // A job being collected sends nothing, so its references are not needed again.
      if (!hooks.resumeJob && edit !== (references.length > 0)) fail("invalid-references", "Edits require reference images; generation cannot silently ignore them.");
      // OpenRouter edit capability is refreshed on the pinned endpoint just before approval below.
      // The Flux catalogue read is a free metadata read that falls back to
      // the built-in table on any failure, so checks after it stay local.
      externalReadStarted = connection.provider === "openrouter";
      const catalog = await this.getCatalog(connection.id, { signal, discoverEdits: false }); active();
      const modelId = request.model ?? catalog.defaultModel;
      if (connection.provider === "flux" && ["flux-image-gpt2-high", "flux-image-gpt2-xl"].includes(modelId ?? "")) fail("unsupported-model", "This Flux GPT Image 2 alias is unavailable. Choose flux-image-gpt25-xhigh or flux-image-gpt25-xl explicitly; your selection was not changed.");
      if (!modelId) fail("model-required", "This connection does not offer GPT Image 2. Explicitly choose an available image model.");
      const model = catalog.models.find(item => item.id === modelId);
      if (!model?.generate) fail("unsupported-model", "This model is not available for supported raster image generation.");
      const caps = model!.capabilities;
      if (edit) {
        const reason = connection.provider === "openrouter" ? (pinnedEditTag(modelId!) ? undefined : OPENROUTER_EDIT_REASON) : !model!.edit || !EDIT_URLS[connection.provider] ? model!.editUnavailableReason ?? "" : undefined;
        if (reason !== undefined) fail("unsupported-edit", `Editing is not supported with this model. ${reason}`.trim());
        if (connection.provider !== "openrouter" && references.length > model!.maxReferences) fail("invalid-references", `${references.length} reference images; ${model!.label} takes at most ${model!.maxReferences}. Nothing was sent.`);
        if (references.some(reference => reference.bytes.length > caps.maxReferenceBytes)) fail("invalid-references", `Each reference image must be at most ${mib(caps.maxReferenceBytes)} for ${model!.label}. Nothing was sent.`);
        if (totalBytes > caps.maxReferenceBytesTotal) fail("invalid-references", `The reference images total ${mib(totalBytes)}; ${model!.label} takes at most ${mib(caps.maxReferenceBytesTotal)} together. Nothing was sent.`);
      }
      // Parameters the model does not take are refused plainly, never dropped.
      const count = request.n ?? 1;
      const unsupported = (message: string): never => fail("unsupported-parameter", message);
      if (count > caps.supports.n) unsupported(`${modelId} makes at most ${caps.supports.n === 1 ? "1 image" : `${caps.supports.n} images`} per request. Nothing was sent. Ask for fewer, or ${orChoose(otherModels(catalog, modelId!, edit, item => item.supports.n >= count), "make them one turn at a time")}.`);
      if (count > 1 && edit && connection.provider !== "openai") unsupported("Edits on this connection make one image at a time. Nothing was sent. Leave n out.");
      if (request.outputFormat && !caps.formats.includes(request.outputFormat)) unsupported(`${modelId} returns ${caps.formats.join(", ")}, not ${request.outputFormat}. Nothing was sent. Leave output_format out or ${orChoose(otherModels(catalog, modelId!, edit, item => item.formats.includes(request.outputFormat!)), "use one of those")}.`);
      if (request.outputCompression !== undefined && (!caps.supports.compression || !["jpeg", "webp"].includes(request.outputFormat ?? ""))) unsupported(caps.supports.compression ? "output_compression needs output_format jpeg or webp. Nothing was sent." : `${modelId} does not take output_compression. Nothing was sent. Leave it out.`);
      if (request.background && !caps.supports.background) unsupported(`${modelId} does not take a transparent background. Nothing was sent. Leave background out or ${orChoose(otherModels(catalog, modelId!, edit, item => item.supports.background), "ask for a plain background in the prompt")}.`);
      if (request.background && !["png", "webp"].includes(request.outputFormat ?? caps.formats[0] ?? "png")) unsupported("A transparent background needs output_format png or webp. Nothing was sent.");
      if (request.seed !== undefined && !caps.supports.seed) unsupported(`This model does not take a seed. Nothing was sent. Leave seed out or ${orChoose(otherModels(catalog, modelId!, edit, item => item.supports.seed), "no other model on this connection takes one")}.`);
      // Quality: xAI edits take none; everything else maps through the model.
      const editQualities = edit ? model!.editQualities : undefined;
      if (editQualities && request.quality && !editQualities.includes(request.quality)) fail("unsupported-quality", "This model does not accept that quality setting for edits.");
      // Size by intent, against this model's rule.
      const sizeRequest: ImageSizeRequest = { aspectRatio: request.aspectRatio, resolution: request.resolution, width: request.width, height: request.height, size: request.size, fit: request.fit };
      const sized = resolveImageSize(caps.sizeRule, sizeRequest, caps.defaultSize);
      if (!sized.ok) {
        const native = otherModels(catalog, modelId!, edit, item => { const other = resolveImageSize(item.sizeRule, { ...sizeRequest, fit: "nearest" }, item.defaultSize); return other.ok; });
        fail("unsupported-size", `${sized.message}${native.length ? ` Models on this connection that render it natively: ${native.join(", ")}.` : ""}`);
      }
      const resolved: ResolvedImageSize = (sized as { ok: true; size: ResolvedImageSize }).size;
      const sizeAsked = resolved.asked !== "default";
      const pixelSize = resolved.width && resolved.height ? `${resolved.width}x${resolved.height}` : undefined;
      const sent = editQualities ? { ok: true as const, model: modelId!, sendQuality: false } : sentModelFor(modelId!, caps, request.quality, pixelSize);
      if (!sent.ok) fail("unsupported-quality", (sent as { message: string }).message);
      const quality = "quality" in sent ? sent.quality : undefined;
      let crop: CropImage | null = null;
      if (resolved.exact) {
        crop = await (this.options.crop ?? loadCrop)(); active();
        if (!crop) fail("unsupported-size", `Murage cannot crop images on this computer, so fit: "exact" is not available. Nothing was sent. Ask for ${resolved.rendered} with fit: "nearest".`);
      }
      // The prompt exactly as sent: saved blocks, the scene, and an Avoid:
      // line when the model has no native negative prompt. Never cut.
      const assembled = assembleImagePrompt({ blocks: assembly.blocks?.map(block => block.text), scene: request.prompt, negative: request.negativePrompt, nativeNegative: caps.supports.negative });
      const promptChars = assembled.prompt.length;
      if (promptChars > caps.maxPromptChars && !hooks.resumeJob) fail("prompt-too-long", promptTooLongMessage(promptChars, modelId!, caps.maxPromptChars, otherModels(catalog, modelId!, edit, item => item.maxPromptChars >= promptChars)));
      if (request.condensedFromChars !== undefined && request.condensedFromChars <= promptChars) unsupported(`condensed_from_chars (${fmt(request.condensedFromChars)}) must be more than the prompt's ${fmt(promptChars)} characters. Nothing was sent.`);
      // Delivery: stream, job or one buffered answer.
      const pixels = resolved.width && resolved.height ? resolved.width * resolved.height : 1_048_576;
      const expected = quality && caps.expectedSeconds?.[quality] ? caps.expectedSeconds[quality]! * Math.max(1, pixels / 1_048_576) : undefined;
      const longRender = expected !== undefined ? expected > LONG_RENDER_SECONDS : ["xhigh", "max"].includes(quality ?? "") || pixels > 2_400_000;
      const streams = ["openai", "flux"].includes(connection.provider) && (edit ? caps.delivery.streamEdits : caps.delivery.stream) && (connection.provider !== "openai" || count === 1);
      const delivery: ImageDelivery = connection.provider === "flux" && caps.delivery.jobs && longRender ? "job" : streams ? "stream" : "buffered";
      const payload: Record<string, unknown> = { model: sent.model, prompt: assembled.prompt, n: count };
      // A native negative prompt is its own field: the card shows it beside the prompt.
      const nativeNegative = connection.provider === "flux" && caps.supports.negative ? request.negativePrompt?.trim() || undefined : undefined;
      let endpointTag: string | undefined;
      if (connection.provider === "openrouter") {
        let info: unknown;
        try { info = await this.openRouterEndpoints(modelId!, signal); } catch (error) { active(); throw error; }
        active();
        const match: EndpointMatch = { modelId: modelId!, outputFormat: model!.outputFormat, quality, size: sizeAsked ? pixelSize : undefined };
        if (edit) {
          const capability = pinnedEditCapability(info, match);
          if (!capability) fail("unsupported-edit", "Editing is not supported with this model. Its pinned endpoint did not advertise a compatible reference range.");
          if (references.length < capability!.minReferences || references.length > capability!.maxReferences) fail("invalid-references", `This endpoint accepts ${capability!.minReferences} to ${capability!.maxReferences} reference images.`);
          endpointTag = capability!.tag;
        } else {
          const endpoint = endpointRows(info).find(row => rasterCompatible(row.parameters, match));
          if (!endpoint) fail("unsupported-model", "No verified raster endpoint supports these image settings.");
          endpointTag = endpoint!.tag;
        }
        Object.assign(payload, { output_format: model!.outputFormat, provider: { only: [endpointTag], allow_fallbacks: false }, ...(quality ? { quality } : {}), ...(sizeAsked && pixelSize ? { size: pixelSize } : {}) });
      } else if (connection.provider === "openai") {
        Object.assign(payload, { quality, size: pixelSize, output_format: request.outputFormat ?? "png",
          ...(request.outputCompression !== undefined ? { output_compression: request.outputCompression } : {}), ...(request.background ? { background: request.background } : {}) });
      } else if (connection.provider === "flux") {
        Object.assign(payload, resolved.tier ? { ...(resolved.aspectRatio ? { aspect_ratio: resolved.aspectRatio } : {}), image_size: resolved.tier } : pixelSize ? { size: pixelSize } : {});
        payload.response_format = "b64_json";
        if (sent.sendQuality && quality) payload.quality = quality;
        if (request.outputFormat) payload.output_format = request.outputFormat;
        if (request.outputCompression !== undefined) payload.output_compression = request.outputCompression;
        if (request.background) payload.background = request.background;
        if (request.seed !== undefined) payload.seed = request.seed;
        if (nativeNegative) payload.negative_prompt = nativeNegative;
        if (edit) delete payload.n;
      } else if (connection.provider === "google") {
        if (resolved.aspectRatio) payload.aspect_ratio = resolved.aspectRatio;
        if (resolved.tier) payload.image_size = resolved.tier;
        if (request.seed !== undefined) payload.seed = request.seed;
      } else Object.assign(payload, { ...(quality ? { quality } : {}), response_format: "b64_json" });
      if (delivery === "stream") {
        payload.stream = true;
        // No router keepalive: one preview frame keeps bytes moving past the
        // edge's ~100 s cut. OpenAI sends nothing else until the image is
        // done, so a direct OpenAI stream always asks for one.
        if (connection.provider === "openai" || (longRender && !caps.delivery.keepaliveSeconds)) payload.partial_images = 1;
      }
      const promptBlocks = assembly.blocks?.length ? assembly.blocks.map(block => ({ name: block.name, version: block.version, scope: block.scope, chars: block.text.trim().length })) : assembly.keptBlocks;
      const details: ImageOperationDetails = { connectionId: connection.id, provider: connection.provider, model: modelId!, operation: request.operation, count, referenceCount: references.length,
        ...(hooks.connectionLabel ? { connectionLabel: hooks.connectionLabel.slice(0, 120) } : {}),
        ...(quality ? { quality } : {}), ...(pixelSize ? { size: pixelSize } : {}), ...(endpointTag ? { endpointTag } : {}),
        ...(sent.model !== modelId ? { sentModel: sent.model } : {}), sizeAsked: resolved.asked, sizeRendered: resolved.rendered,
        ...(resolved.exact ? { cropTo: resolved.exact.width ? `${resolved.exact.width}x${resolved.exact.height}` : `${resolved.asked} (centre crop)` } : {}),
        ...(resolved.experimental ? { experimentalSize: true } : {}),
        promptChars, promptSha256: sha256(assembled.prompt), ...(request.condensedFromChars !== undefined ? { condensedFromChars: request.condensedFromChars } : {}),
        ...(assembled.avoidLine ? { avoidLine: true } : {}), ...(nativeNegative ? { negativeChars: nativeNegative.length } : {}), ...(request.outputFormat ? { outputFormat: request.outputFormat } : {}),
        ...(request.outputCompression !== undefined ? { outputCompression: request.outputCompression } : {}), ...(request.background ? { background: request.background } : {}),
        ...(request.seed !== undefined ? { seed: request.seed } : {}), ...(edit || references.length ? { referenceCap: model!.maxReferences } : {}),
        ...(assembly.referencePack ? { referencePack: assembly.referencePack } : {}), ...(promptBlocks?.length ? { promptBlocks, promptScene: Boolean(request.prompt) } : {}),
        delivery, ...(connection.provider === "flux" && edit && caps.editTimeoutSeconds ? { editTimeoutSeconds: caps.editTimeoutSeconds } : {}),
        ...(hooks.resumeJob ? { jobId: hooks.resumeJob.id } : {}) };
      const outbound = serializeImageRequest(connection.provider, request.operation, payload, references);
      assertCredentialOrigin(connection.provider, outbound.url);
      if (connection.provider === "flux") {
        // A repeated request with this key returns the same job or result, never a second render.
        outbound.headers["idempotency-key"] = sha256(hooks.operationId ?? randomUUID());
        if (delivery === "job") outbound.headers.prefer = "respond-async";
      }
      active();
      reservationStarted = true;
      const card: ImageApprovalCardInput = { prompt: assembled.prompt, ...(nativeNegative ? { negativePrompt: nativeNegative } : {}) };
      try { reservation = await hooks.reserve(details, card); } catch { fail("permission-denied", "Image generation was not approved."); }
      // The render's own limits start after the separately bounded owner review.
      // OpenAI renders several large images in one buffered answer: it gets the full ceiling.
      const renderSignal = () => AbortSignal.timeout(delivery === "buffered" && connection.provider !== "openai" ? BUFFERED_DEADLINE_MS : RENDER_CEILING_MS);
      signal = hooks.signal ? AbortSignal.any([hooks.signal, renderSignal()]) : renderSignal();
      active();
      if (connection.provider === "openrouter") {
        const fresh = (await this.getCatalog(connection.id, { signal, discoverEdits: false })).models.find(item => item.id === modelId);
        active();
        const size = sizeAsked ? pixelSize : undefined;
        if (!fresh?.generate || fresh.outputFormat !== model!.outputFormat || (quality && !fresh.qualities.includes(quality)) || (size && !fresh.sizes.includes(size))) fail("capability-changed", "The approved image model capabilities changed. No image request was sent.");
        const info = await this.openRouterEndpoints(modelId!, signal); active();
        const match: EndpointMatch = { modelId: modelId!, outputFormat: fresh!.outputFormat, quality, size };
        const capability = edit ? pinnedEditCapability(info, match) : undefined;
        const compatible = edit ? capability != null && capability.tag === endpointTag && references.length >= capability.minReferences && references.length <= capability.maxReferences
          : endpointRows(info).some(row => row.tag === endpointTag && rasterCompatible(row.parameters, match));
        if (!compatible) fail("capability-changed", "The approved image endpoint capabilities changed. No image request was sent.");
      }
      active();
      outcome = "uncertain";
      const auth = connection.provider === "google" ? { "x-goog-api-key": connection.apiKey } : { authorization: `Bearer ${connection.apiKey}` };
      const pollJob = (id: string, firstDelaySeconds?: number) => {
        const url = `${FLUX_JOBS_URL}/${encodeURIComponent(id)}`;
        assertCredentialOrigin(connection.provider, url);
        return pollImageJob({ id, firstDelaySeconds, signal, sleep: this.options.sleep ?? defaultSleep, now: this.options.now ?? Date.now,
          // A changed connection, a lost authorization or a cancel stops at once with its own reason.
          fatal: error => error instanceof ImageGenerationError,
          get: async pollSignal => { active(); const response = await this.fetcher(url, { headers: auth, signal: pollSignal, redirect: "error" }); return { status: response.status, body: response.ok ? await boundedJson(response, imageResponseCap(count)) : (void response.body?.cancel(), null) }; } });
      };
      let result: unknown;
      if (hooks.resumeJob) result = await pollJob(hooks.resumeJob.id, 2);
      else {
        // OpenAI sends no keepalive and its one preview frame can come late on
        // a large render; with no edge in between, it gets the buffered deadline.
        const idleMs = streamIdleMs(connection.provider, caps.delivery.keepaliveSeconds);
        // The idle clock starts at the response headers: until then only the
        // render ceiling applies (a provider may hold headers while it works).
        const idle = delivery === "stream" ? idleWatch(idleMs, false) : null;
        try {
          const response = await this.fetcher(outbound.url, { method: "POST", headers: { ...outbound.headers, ...auth }, body: outbound.body, signal: idle ? AbortSignal.any([signal, idle.signal]) : signal, redirect: "error" });
          idle?.touch();
          if (!response.ok) {
            outcome = response.status >= 400 && response.status < 500 ? "failed" : "uncertain";
            // A 4xx body from the provider says why (Flux: error.code such as
            // moderation_blocked or invalid_reference_image, plus error.message).
            // Throwing it away left the person with only the status number.
            const detail = outcome === "failed" ? await providerErrorDetail(response) : (void response.body?.cancel(), "");
            fail("provider-error", `The selected image provider rejected the request (HTTP ${response.status})${detail}. No fallback or automatic retry was attempted.`, outcome);
          }
          const type = response.headers.get("content-type") ?? "";
          if (type.includes("text/event-stream") && response.body) result = await readImageEventStream(response.body, { onActivity: idle?.touch, maxEventBytes: imageResponseCap(count), maxTotalBytes: IMAGE_RESPONSE_MAX_BYTES, expected: count });
          else {
            result = await boundedJson(response, imageResponseCap(count));
            // Only Flux runs jobs (contract section 4); any other 202 is read as an answer.
            const job = connection.provider === "flux" && (response.status === 202 || delivery === "job") ? parseImageJob(result) : null;
            if (connection.provider === "flux" && response.status === 202 && !job) fail("invalid-response", "The image provider accepted the request but returned no job to follow.", "uncertain");
            if (job) {
              // Durable before the first poll: the same request_id resumes this job.
              hooks.jobStarted?.({ id: job.id });
              details.jobId = job.id;
              idle?.stop();
              result = await pollJob(job.id, job.pollAfterSeconds);
            }
          }
        } catch (error) {
          if (idle?.fired()) fail("provider-idle", `The image provider sent nothing for ${Math.round(idleMs / 1000)} seconds, so Murage stopped waiting. The render may still finish on the provider's side. Check before trying again; no automatic retry was attempted.`, "uncertain");
          throw error;
        } finally { idle?.stop(); }
      }
      const encodedList = connection.provider === "google" ? [googleImageData(result)].filter((item): item is string => item !== undefined)
        : record(result) && Array.isArray(result.data) ? result.data.flatMap(item => record(item) && typeof item.b64_json === "string" ? [item.b64_json] : []) : [];
      // More images than asked is not a result Murage asked for: nothing is published.
      if (connection.provider === "google" && !encodedList.length) fail("invalid-image", googleNoImageReason(result), outcome);
      if (!record(result) || !encodedList.length || encodedList.length > count) fail("invalid-image", count === 1 ? "The image provider did not return one supported image." : `The image provider did not return up to ${count} supported images.`, outcome);
      const images: Array<{ image: DecodedGeneratedImage; delivered: DeliveredImage; index: number }> = [];
      const notKept: Array<{ index: number; bytes: number }> = [];
      for (const [encodedIndex, encoded] of encodedList.entries()) {
        let image: DecodedGeneratedImage;
        try { image = decodeGeneratedImage(encoded, GENERATED_IMAGE_RECEIVE_MAX_BYTES); } catch { return fail("invalid-image", "The image provider returned invalid or oversized raster bytes.", outcome); }
        if (connection.provider === "flux" && edit && image.mime !== "image/png") fail("invalid-image", "Flux did not return the PNG required by its edit contract.", outcome);
        let rendered = pixelsIn(image.bytes), cropped = false, cropFailed = false;
        if (resolved.exact && crop && rendered) {
          const target = exactTarget(resolved.exact, rendered);
          if (target.width !== rendered.width || target.height !== rendered.height) {
            // The paid render is kept either way: a crop that fails or returns
            // something unreadable delivers the render as it came, stated.
            try {
              const croppedImage = decodeGeneratedImage((await crop(image.bytes, target.width, target.height)).toString("base64"), GENERATED_IMAGE_RECEIVE_MAX_BYTES);
              const croppedPixels = pixelsIn(croppedImage.bytes);
              if (!croppedPixels || croppedPixels.width !== target.width || croppedPixels.height !== target.height) throw new Error("crop size");
              image = croppedImage; rendered = croppedPixels; cropped = true;
            } catch { cropFailed = true; }
          }
        }
        // Kept images match what Files, the viewer and Save accept: a larger render is named, not cut.
        // Of several, the ones that fit are kept and the rest are named.
        if (image.bytes.length > GENERATED_IMAGE_MAX_BYTES) { notKept.push({ index: encodedIndex, bytes: image.bytes.length }); continue; }
        images.push({ image, index: encodedIndex, delivered: { ...(rendered ? rendered : {}), mime: image.mime, bytes: image.bytes.length, ...(cropped ? { cropped } : {}), ...(cropFailed ? { cropFailed } : {}) } });
      }
      if (!images.length) {
        const largest = Math.max(...notKept.map(item => item.bytes));
        fail("image-too-large", `The render arrived at ${mib(largest)}; Murage keeps images up to ${mib(GENERATED_IMAGE_MAX_BYTES)}. Nothing was published. Ask for output_format jpeg or webp, or a smaller resolution.`, outcome);
      }
      const base: GeneratedImageMetadata = { ...details, ...(notKept.length ? { notKept } : {}), ...(typeof result.model === "string" && result.model.length <= 180 ? { reportedModel: result.model } : {}), ...(endpointTag ? { upstreamProvider: endpointTag } : {}), ...(safeUsage(result) ? { usage: safeUsage(result) } : {}) };
      const artifacts: T[] = [];
      // Every image is handed over even when an earlier one fails to publish,
      // so each is retained with its receipt and the same request_id can
      // finish them all. The first failure is reported after the last image.
      let publishFailure: { error: unknown } | undefined;
      for (const item of images) {
        const metadata: GeneratedImageMetadata = { ...base, delivered: [item.delivered], ...(images.length > 1 || notKept.length ? { imageIndex: item.index } : {}) };
        try { active(); artifacts.push(await hooks.publish(item.image, { ...metadata, summary: imageResultSummary(metadata) })); }
        catch (error) { publishFailure ??= { error }; }
      }
      if (publishFailure) throw publishFailure.error;
      outcome = "published";
      const metadata: GeneratedImageMetadata = { ...base, delivered: images.map(item => item.delivered) };
      return { artifact: artifacts[0]!, artifacts, metadata: { ...metadata, summary: imageResultSummary(metadata) } };
    } catch (error) {
      if (error instanceof ImageDeliveryError) { outcome = error.outcome; throw new ImageGenerationError(error.code, error.message, error.outcome); }
      if (error instanceof ImageGenerationError) {
        // Only deterministic local validation, before any external read or
        // approval, can release the turn slot. Unknown failures stay fenced.
        // The prompt, parameter and size checks after a free catalogue read
        // are just as local: nothing was sent, so they stay correctable too.
        if (!reservationStarted && LOCAL_PREFLIGHT_CODES.has(error.code) && (!externalReadStarted || CATALOGUE_CHECK_CODES.has(error.code))) {
          active();
          throw new ImageGenerationError(error.code, error.message, error.outcome, true);
        }
        throw error;
      }
      // 0.1.54 taught the 4xx path to say what the provider objected to. The
      // same courtesy for a request that never got a reply at all: which wall
      // it hit, in words, instead of one sentence that fits every failure.
      const transport = describeTransportFailure(error);
      throw new ImageGenerationError(transport.code, `${transport.message} No fallback or automatic retry was attempted.`, outcome);
    } finally {
      if (reservation) {
        try { await reservation.finish(outcome); }
        catch { throw new ImageGenerationError("receipt-failed", "The image attempt receipt could not be saved. Check the existing result before trying again.", outcome); }
      }
    }
  }
}
/** The real pixels from the image's own header. */
function pixelsIn(bytes: Buffer): { width: number; height: number } | undefined {
  const sniffed = sniffMedia(bytes.subarray(0, Math.min(bytes.length, 256 * 1024)), bytes.length);
  return sniffed.width && sniffed.height ? { width: sniffed.width, height: sniffed.height } : undefined;
}
