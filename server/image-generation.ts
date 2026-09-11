import { z } from "zod";
import { IMAGE_REFERENCE_LIMITS } from "../shared/media-assets.ts";
import { decodeGeneratedImage, type DecodedGeneratedImage } from "./generated-image.ts";

export type ImageProvider = "openai" | "flux" | "openrouter" | "xai";
/** Only the server connection resolver constructs this object. Never serialize it. */
export interface ImageConnection { id: string; provider: ImageProvider; apiKey: string; revision: string }
export interface ImageReference { bytes: Buffer; mime: "image/png" | "image/jpeg" | "image/webp" }
export const imageGenerationRequestSchema = z.object({
  connectionId: z.string().min(1).max(160), model: z.string().min(1).max(180).optional(),
  operation: z.enum(["generate", "edit"]).default("generate"), prompt: z.string().trim().min(1).max(4000),
  quality: z.enum(["low", "medium", "high"]).optional(),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional(),
}).strict();
export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;
export interface ImageModelOption {
  id: string; label: string; generate: boolean; edit: boolean;
  availability: "unverified" | "catalog-listed"; disabledReason?: string;
  qualities: string[]; sizes: string[]; outputFormat?: "png" | "jpeg" | "webp";
  /** Most reference images this adapter sends for one edit. 0 when editing is unavailable. Never above Murage's shared cap. */
  maxReferences: number;
  /** Why editing is unavailable for this model, when it is. */
  editUnavailableReason?: string;
  /** Edit-specific quality support when it differs from generation. xAI edits take no quality field. */
  editQualities?: string[];
}
export interface ImageCatalog { connectionId: string; provider: ImageProvider; defaultModel: string | null; models: ImageModelOption[] }
export type ImageAttemptOutcome = "not-dispatched" | "failed" | "uncertain" | "published";
export interface ImageOperationDetails {
  connectionId: string; provider: ImageProvider; model: string; operation: "generate" | "edit";
  count: 1; referenceCount: number; quality?: string; size?: string;
  /** OpenRouter only: the upstream endpoint pinned before owner approval. */
  endpointTag?: string;
}
export interface GeneratedImageMetadata extends ImageOperationDetails {
  reportedModel?: string; upstreamProvider?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
}
export interface ImageGenerationHooks<T> {
  signal?: AbortSignal;
  /** Must check current bot/thread/generation/owner authorization synchronously. */
  assertActive: () => void;
  /** Root owns durable permission/count admission; details contain no credentials. */
  reserve: (details: ImageOperationDetails) => Promise<{ finish: (outcome: ImageAttemptOutcome) => void | Promise<void> }>;
  /** Root must revalidate authority atomically with its owned artifact commit. */
  publish: (image: DecodedGeneratedImage, metadata: GeneratedImageMetadata) => Promise<T>;
}
export class ImageGenerationError extends Error {
  readonly code: string;
  readonly outcome: ImageAttemptOutcome;
  constructor(code: string, message: string, outcome: ImageAttemptOutcome = "not-dispatched") { super(message); this.code = code; this.outcome = outcome; }
}
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const ENDPOINT_TIMEOUT_MS = 15_000;
const REFERENCE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
const OPENAI_MODELS = ["gpt-image-2", "gpt-image-2-2026-04-21", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"];
const FLUX_MODELS = [
  { id: "flux-image-gpt2", quality: "medium", size: "1024x1024" },
  { id: "flux-image-gpt2-low", quality: "low", size: "1024x1024" },
  { id: "flux-image-gpt2-high", quality: "high", size: "1024x1024" },
  { id: "flux-image-gpt2-xl", quality: "high", size: "1536x1024" },
];
/** The only origin each provider's key may be sent to. */
const PROVIDER_ORIGINS: Record<ImageProvider, string> = {
  openai: "https://api.openai.com", flux: "https://api.fluxrouter.ai", openrouter: "https://openrouter.ai", xai: "https://api.x.ai",
};
const URLS: Record<ImageProvider, string> = {
  openai: "https://api.openai.com/v1/images/generations", flux: "https://api.fluxrouter.ai/v1/images/generations",
  openrouter: "https://openrouter.ai/api/v1/images", xai: "https://api.x.ai/v1/images/generations",
};
/** Providers with an implemented reference-edit transport. Flux has no edit contract. */
const EDIT_URLS: Partial<Record<ImageProvider, string>> = {
  openai: "https://api.openai.com/v1/images/edits", xai: "https://api.x.ai/v1/images/edits", openrouter: "https://openrouter.ai/api/v1/images",
};
/** OpenRouter models admitted for reference edits, each pinned to one upstream endpoint. */
const OPENROUTER_EDIT_ENDPOINTS: Readonly<Record<string, string>> = { "openai/gpt-image-2": "openai" };
const FLUX_EDIT_REASON = "Flux Router offers image generation only. It has no reference-edit contract.";
const OPENROUTER_EDIT_REASON = "Reference editing is not enabled for this OpenRouter model.";
const OPENROUTER_EDIT_UNVERIFIED = "Reference editing could not be verified on this model's pinned endpoint.";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function fail(code: string, message: string, outcome?: ImageAttemptOutcome): never { throw new ImageGenerationError(code, message, outcome); }
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
  const minReferences = Math.max(1, range.min), maxReferences = Math.min(IMAGE_REFERENCE_LIMITS.maxCount, range.max);
  return minReferences <= maxReferences ? { tag, minReferences, maxReferences } : null;
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
    models.push({ id: row.id, label: typeof row.name === "string" ? row.name.slice(0, 120) : row.id,
      generate, edit: false, maxReferences: 0, availability: "catalog-listed",
      editUnavailableReason: generate && pinnedEditTag(row.id) ? OPENROUTER_EDIT_UNVERIFIED : OPENROUTER_EDIT_REASON,
      ...(video || (!format && !documentedGpt2) ? { disabledReason: "A supported raster output format is not advertised by this adapter." } : {}),
      outputFormat: format ?? (documentedGpt2 ? "png" : undefined),
      qualities: values(row.supported_parameters, "quality"), sizes: values(row.supported_parameters, "size"),
    });
  }
  return models;
}
function staticCatalog(connection: ImageConnection): ImageCatalog {
  const base = { connectionId: connection.id, provider: connection.provider };
  if (connection.provider === "openai") return { ...base, defaultModel: "gpt-image-2", models: OPENAI_MODELS.map(id => ({ id, label: id, generate: true, edit: true, maxReferences: IMAGE_REFERENCE_LIMITS.maxCount, availability: "unverified", qualities: ["low", "medium", "high"], sizes: ["1024x1024", "1536x1024", "1024x1536"], outputFormat: "png" })) };
  if (connection.provider === "flux") return { ...base, defaultModel: "flux-image-gpt2", models: FLUX_MODELS.map(model => ({ id: model.id, label: model.id, generate: true, edit: false, maxReferences: 0, editUnavailableReason: FLUX_EDIT_REASON, availability: "unverified", qualities: [model.quality], sizes: [model.size], outputFormat: "png" })) };
  if (connection.provider === "xai") return { ...base, defaultModel: null, models: [{ id: "grok-imagine-image-2.0", label: "Grok Imagine Image 2.0", generate: true, edit: true, maxReferences: IMAGE_REFERENCE_LIMITS.maxCount, availability: "unverified", qualities: ["low", "medium"], editQualities: [], sizes: [] }] };
  return { ...base, defaultModel: "openai/gpt-image-2", models: [] };
}
const dataUrl = (reference: ImageReference) => `data:${reference.mime};base64,${reference.bytes.toString("base64")}`;
/**
 * Chooses the provider-specific transport after shared validation. The key is
 * not part of the result; it is attached only at dispatch, after
 * assertCredentialOrigin has accepted this URL.
 */
function serializeImageRequest(provider: ImageProvider, operation: "generate" | "edit", payload: Record<string, unknown>, references: readonly ImageReference[]): { url: string; body: string | FormData; headers: Record<string, string> } {
  if (operation === "generate") return { url: URLS[provider], body: JSON.stringify(payload), headers: { "content-type": "application/json" } };
  const url = EDIT_URLS[provider];
  if (!url) return fail("unsupported-edit", "Editing is not supported on this image connection.");
  if (provider === "openai") {
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
function safeUsage(payload: Record<string, unknown>): GeneratedImageMetadata["usage"] {
  if (!record(payload.usage)) return undefined;
  const usage = payload.usage; const result: NonNullable<GeneratedImageMetadata["usage"]> = {};
  for (const [output, names] of [["inputTokens", ["input_tokens", "prompt_tokens"]], ["outputTokens", ["output_tokens", "completion_tokens"]], ["totalTokens", ["total_tokens"]], ["costUsd", ["cost"]]] as const) {
    const value = names.map(name => usage[name]).find(item => typeof item === "number" && Number.isFinite(item) && item >= 0);
    if (typeof value === "number") result[output] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
export class ImageGenerationService {
  private readonly fetcher: typeof fetch;
  private readonly options: { resolveConnection: (id: string) => ImageConnection | null; connectionIds: () => string[]; fetch?: typeof fetch };
  constructor(options: { resolveConnection: (id: string) => ImageConnection | null; connectionIds: () => string[]; fetch?: typeof fetch }) { this.options = options; this.fetcher = options.fetch ?? fetch; }
  private connection(id: string): ImageConnection {
    let found: ImageConnection | null;
    try { found = this.options.resolveConnection(id); } catch { return fail("connection-unavailable", "The image connection could not be read. Review it in Settings."); }
    if (!found || found.id !== id || !Object.hasOwn(URLS, found.provider) || !found.apiKey.trim()) fail("connection-unavailable", "Choose a configured image connection in Settings.");
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
  listConnections(): Array<{ id: string; provider: ImageProvider; defaultModel: string | null }> {
    return [...new Set(this.options.connectionIds())].slice(0, 32).flatMap(id => {
      try { const connection = this.connection(id); return [{ id, provider: connection.provider, defaultModel: staticCatalog(connection).defaultModel }]; }
      catch { return []; }
    });
  }
  /**
   * `discoverEdits` (default true) checks each admitted OpenRouter edit model's
   * pinned endpoint. A failed check keeps generation and shows editing unavailable.
   */
  async getCatalog(connectionId: string, options: { signal?: AbortSignal; discoverEdits?: boolean } = {}): Promise<ImageCatalog> {
    const { signal, discoverEdits = true } = options;
    const connection = this.connection(connectionId); const catalog = staticCatalog(connection);
    if (connection.provider !== "openrouter") return catalog;
    const response = await this.fetcher("https://openrouter.ai/api/v1/images/models", { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) fail("catalog-unavailable", "Could not refresh the image model catalog. Try again later.");
    const models = parseOpenRouterImageCatalog(await boundedJson(response, MAX_CATALOG_BYTES));
    if (discoverEdits) {
      for (const model of models) {
        if (!model.generate || model.disabledReason || !pinnedEditTag(model.id)) continue;
        let capability: ReturnType<typeof pinnedEditCapability> = null;
        try { capability = pinnedEditCapability(await this.openRouterEndpoints(model.id, signal), { modelId: model.id, outputFormat: model.outputFormat }); } catch { capability = null; }
        if (capability) { model.edit = true; model.maxReferences = capability.maxReferences; delete model.editUnavailableReason; }
      }
    }
    return { ...catalog, models };
  }
  async generate<T>(raw: unknown, hooks: ImageGenerationHooks<T>, references: readonly ImageReference[] = []): Promise<{ artifact: T; metadata: GeneratedImageMetadata }> {
    const parsed = imageGenerationRequestSchema.safeParse(raw);
    if (!parsed.success) fail("invalid-request", "Choose a connection, supported model and prompt of at most 4,000 characters. URLs and keys are not accepted.");
    const request = parsed.data!; const connection = this.connection(request.connectionId);
    let signal = hooks.signal ? AbortSignal.any([hooks.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    let outcome: ImageAttemptOutcome = "not-dispatched"; let reservation: Awaited<ReturnType<ImageGenerationHooks<T>["reserve"]>> | undefined;
    const active = () => {
      if (signal.aborted) fail("cancelled", "Image generation was cancelled. No automatic retry was attempted.", outcome);
      try { hooks.assertActive(); } catch { fail("not-authorized", "This image request is no longer authorized.", outcome); }
      const current = this.options.resolveConnection(connection.id);
      if (!current || current.provider !== connection.provider || current.revision !== connection.revision || current.apiKey !== connection.apiKey) fail("connection-changed", "The image connection changed. Review it before trying again.", outcome);
    };
    try {
      active();
      if (references.length > IMAGE_REFERENCE_LIMITS.maxCount || references.reduce((sum, item) => sum + item.bytes.length, 0) > IMAGE_REFERENCE_LIMITS.maxTotalBytes) fail("invalid-references", "Use at most four reference images, each up to 10 MiB and 20 MiB in total.");
      for (const reference of references) {
        if (!Buffer.isBuffer(reference.bytes) || !reference.bytes.length || reference.bytes.length > IMAGE_REFERENCE_LIMITS.maxBytesEach || !REFERENCE_MIMES.includes(reference.mime)) fail("invalid-references", "Reference images must be bounded PNG, JPEG or WebP files.");
        if (decodeGeneratedImage(reference.bytes.toString("base64")).mime !== reference.mime) fail("invalid-references", "A reference image has an invalid format.");
      }
      const edit = request.operation === "edit";
      if (edit !== (references.length > 0)) fail("invalid-references", "Edits require reference images; generation cannot silently ignore them.");
      // OpenRouter edit capability is refreshed on the pinned endpoint just before approval below.
      const catalog = await this.getCatalog(connection.id, { signal, discoverEdits: false }); active();
      const modelId = request.model ?? catalog.defaultModel;
      if (!modelId) fail("model-required", "This connection does not offer GPT Image 2. Explicitly choose an available image model.");
      const model = catalog.models.find(item => item.id === modelId);
      if (!model?.generate) fail("unsupported-model", "This model is not available for supported raster image generation.");
      if (edit) {
        const reason = connection.provider === "openrouter" ? (pinnedEditTag(modelId!) ? undefined : OPENROUTER_EDIT_REASON) : !model!.edit || !EDIT_URLS[connection.provider] ? model!.editUnavailableReason ?? "" : undefined;
        if (reason !== undefined) fail("unsupported-edit", `Editing is not supported with this model. ${reason}`.trim());
        if (connection.provider !== "openrouter" && references.length > model!.maxReferences) fail("invalid-references", `This model accepts at most ${model!.maxReferences} reference images.`);
      }
      const editQualities = edit ? model!.editQualities : undefined;
      if (request.quality && !(editQualities ?? model!.qualities).includes(request.quality)) fail("unsupported-quality", editQualities ? "This model does not accept that quality setting for edits." : "This model does not support that quality setting.");
      if (request.size && !model!.sizes.includes(request.size)) fail("unsupported-size", "This model does not support that image size.");
      const quality = request.quality ?? (connection.provider === "openai" ? "medium" : connection.provider === "flux" ? model!.qualities[0] : connection.provider === "xai" && !edit ? "low" : undefined);
      const size = request.size ?? (["openai", "flux"].includes(connection.provider) ? model!.sizes[0] : undefined);
      const payload: Record<string, unknown> = { model: modelId, prompt: request.prompt, n: 1 };
      let endpointTag: string | undefined;
      if (connection.provider === "openrouter") {
        let info: unknown;
        try { info = await this.openRouterEndpoints(modelId!, signal); } catch (error) { active(); throw error; }
        active();
        const match: EndpointMatch = { modelId: modelId!, outputFormat: model!.outputFormat, quality, size };
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
        Object.assign(payload, { output_format: model!.outputFormat, provider: { only: [endpointTag], allow_fallbacks: false }, ...(quality ? { quality } : {}), ...(size ? { size } : {}) });
      } else if (connection.provider === "openai") Object.assign(payload, { quality, size, output_format: "png" });
      else if (connection.provider === "flux") Object.assign(payload, { size, response_format: "b64_json" });
      else Object.assign(payload, { ...(quality ? { quality } : {}), response_format: "b64_json" });
      const details: ImageOperationDetails = { connectionId: connection.id, provider: connection.provider, model: modelId!, operation: request.operation, count: 1, referenceCount: references.length, ...(quality ? { quality } : {}), ...(size ? { size } : {}), ...(endpointTag ? { endpointTag } : {}) };
      const outbound = serializeImageRequest(connection.provider, request.operation, payload, references);
      assertCredentialOrigin(connection.provider, outbound.url);
      active();
      try { reservation = await hooks.reserve(details); } catch { fail("permission-denied", "Image generation was not approved."); }
      // The provider deadline starts after the separately bounded owner review.
      signal = hooks.signal ? AbortSignal.any([hooks.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
      active();
      outcome = "uncertain";
      const response = await this.fetcher(outbound.url, { method: "POST", headers: { ...outbound.headers, authorization: `Bearer ${connection.apiKey}` }, body: outbound.body, signal, redirect: "error" });
      if (!response.ok) {
        outcome = response.status >= 400 && response.status < 500 ? "failed" : "uncertain";
        void response.body?.cancel();
        fail("provider-error", `The selected image provider rejected the request (HTTP ${response.status}). No fallback or automatic retry was attempted.`, outcome);
      }
      const result = await boundedJson(response, MAX_RESPONSE_BYTES);
      if (!record(result) || !Array.isArray(result.data) || result.data.length !== 1 || !record(result.data[0]) || typeof result.data[0].b64_json !== "string") fail("invalid-image", "The image provider did not return one supported image.", outcome);
      let image: DecodedGeneratedImage;
      try { image = decodeGeneratedImage(result.data[0].b64_json); } catch { return fail("invalid-image", "The image provider returned invalid or oversized raster bytes.", outcome); }
      const metadata: GeneratedImageMetadata = { ...details, ...(typeof result.model === "string" && result.model.length <= 180 ? { reportedModel: result.model } : {}), ...(endpointTag ? { upstreamProvider: endpointTag } : {}), ...(safeUsage(result) ? { usage: safeUsage(result) } : {}) };
      active(); const artifact = await hooks.publish(image, metadata); outcome = "published";
      return { artifact, metadata };
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      throw new ImageGenerationError("request-failed", "Image generation could not complete. No fallback or automatic retry was attempted.", outcome);
    } finally {
      if (reservation) {
        try { await reservation.finish(outcome); }
        catch { throw new ImageGenerationError("receipt-failed", "The image attempt receipt could not be saved. Check the existing result before trying again.", outcome); }
      }
    }
  }
}
