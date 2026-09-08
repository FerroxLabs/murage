import { z } from "zod";
import { IMAGE_MAX_BYTES } from "./attachments.ts";
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
}
export interface ImageCatalog { connectionId: string; provider: ImageProvider; defaultModel: string | null; models: ImageModelOption[] }
export type ImageAttemptOutcome = "not-dispatched" | "failed" | "uncertain" | "published";
export interface ImageOperationDetails {
  connectionId: string; provider: ImageProvider; model: string; operation: "generate" | "edit";
  count: 1; referenceCount: number; quality?: string; size?: string;
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
const OPENAI_MODELS = ["gpt-image-2", "gpt-image-2-2026-04-21", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"];
const FLUX_MODELS = [
  { id: "flux-image-gpt2", quality: "medium", size: "1024x1024" },
  { id: "flux-image-gpt2-low", quality: "low", size: "1024x1024" },
  { id: "flux-image-gpt2-high", quality: "high", size: "1024x1024" },
  { id: "flux-image-gpt2-xl", quality: "high", size: "1536x1024" },
];
const URLS: Record<ImageProvider, string> = {
  openai: "https://api.openai.com/v1/images/generations", flux: "https://api.fluxrouter.ai/v1/images/generations",
  openrouter: "https://openrouter.ai/api/v1/images", xai: "https://api.x.ai/v1/images/generations",
};
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
    models.push({ id: row.id, label: typeof row.name === "string" ? row.name.slice(0, 120) : row.id,
      generate: !video && Boolean(format || documentedGpt2), edit: false, availability: "catalog-listed",
      ...(video || (!format && !documentedGpt2) ? { disabledReason: "A supported raster output format is not advertised by this adapter." } : {}),
      outputFormat: format ?? (documentedGpt2 ? "png" : undefined),
      qualities: values(row.supported_parameters, "quality"), sizes: values(row.supported_parameters, "size"),
    });
  }
  return models;
}
function staticCatalog(connection: ImageConnection): ImageCatalog {
  const base = { connectionId: connection.id, provider: connection.provider };
  if (connection.provider === "openai") return { ...base, defaultModel: "gpt-image-2", models: OPENAI_MODELS.map(id => ({ id, label: id, generate: true, edit: true, availability: "unverified", qualities: ["low", "medium", "high"], sizes: ["1024x1024", "1536x1024", "1024x1536"], outputFormat: "png" })) };
  if (connection.provider === "flux") return { ...base, defaultModel: "flux-image-gpt2", models: FLUX_MODELS.map(model => ({ id: model.id, label: model.id, generate: true, edit: false, availability: "unverified", qualities: [model.quality], sizes: [model.size], outputFormat: "png" })) };
  if (connection.provider === "xai") return { ...base, defaultModel: null, models: [{ id: "grok-imagine-image-2.0", label: "Grok Imagine Image 2.0", generate: true, edit: false, availability: "unverified", qualities: ["low", "medium"], sizes: [] }] };
  return { ...base, defaultModel: "openai/gpt-image-2", models: [] };
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
  listConnections(): Array<{ id: string; provider: ImageProvider; defaultModel: string | null }> {
    return [...new Set(this.options.connectionIds())].slice(0, 32).flatMap(id => {
      try { const connection = this.connection(id); return [{ id, provider: connection.provider, defaultModel: staticCatalog(connection).defaultModel }]; }
      catch { return []; }
    });
  }
  async getCatalog(connectionId: string, options: { signal?: AbortSignal } = {}): Promise<ImageCatalog> {
    const { signal } = options;
    const connection = this.connection(connectionId); const catalog = staticCatalog(connection);
    if (connection.provider !== "openrouter") return catalog;
    const response = await this.fetcher("https://openrouter.ai/api/v1/images/models", { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) fail("catalog-unavailable", "Could not refresh the image model catalog. Try again later.");
    return { ...catalog, models: parseOpenRouterImageCatalog(await boundedJson(response, MAX_CATALOG_BYTES)) };
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
      if (references.length > 4 || references.reduce((sum, item) => sum + item.bytes.length, 0) > 2 * IMAGE_MAX_BYTES) fail("invalid-references", "Use at most four reference images, each up to 10 MiB and 20 MiB in total.");
      for (const reference of references) {
        if (!Buffer.isBuffer(reference.bytes) || !reference.bytes.length || reference.bytes.length > IMAGE_MAX_BYTES || !["image/png", "image/jpeg", "image/webp"].includes(reference.mime)) fail("invalid-references", "Reference images must be bounded PNG, JPEG or WebP files.");
        if (decodeGeneratedImage(reference.bytes.toString("base64")).mime !== reference.mime) fail("invalid-references", "A reference image has an invalid format.");
      }
      if ((request.operation === "edit") !== (references.length > 0)) fail("invalid-references", "Edits require reference images; generation cannot silently ignore them.");
      const catalog = await this.getCatalog(connection.id, { signal }); active();
      const modelId = request.model ?? catalog.defaultModel;
      if (!modelId) fail("model-required", "This connection does not offer GPT Image 2. Explicitly choose an available image model.");
      const model = catalog.models.find(item => item.id === modelId);
      if (!model?.generate) fail("unsupported-model", "This model is not available for supported raster image generation.");
      if (request.operation === "edit" && !model!.edit) fail("unsupported-edit", "Editing is not supported on this image connection. Choose OpenAI for edits.");
      if (request.quality && !model!.qualities.includes(request.quality)) fail("unsupported-quality", "This model does not support that quality setting.");
      if (request.size && !model!.sizes.includes(request.size)) fail("unsupported-size", "This model does not support that image size.");
      const quality = request.quality ?? (connection.provider === "openai" ? "medium" : connection.provider === "flux" ? model!.qualities[0] : connection.provider === "xai" ? "low" : undefined);
      const size = request.size ?? (["openai", "flux"].includes(connection.provider) ? model!.sizes[0] : undefined);
      const details: ImageOperationDetails = { connectionId: connection.id, provider: connection.provider, model: modelId!, operation: request.operation, count: 1, referenceCount: references.length, ...(quality ? { quality } : {}), ...(size ? { size } : {}) };
      let upstreamProvider: string | undefined;
      if (connection.provider === "openrouter") {
        const endpointUrl = `https://openrouter.ai/api/v1/images/models/${modelId!.split("/").map(encodeURIComponent).join("/")}/endpoints`;
        const response = await this.fetcher(endpointUrl, { signal, redirect: "error" });
        if (!response.ok) fail("catalog-unavailable", "Could not verify this image model’s endpoint capabilities.");
        const info = await boundedJson(response, MAX_CATALOG_BYTES); active();
        const endpoints = record(info) && Array.isArray(info.endpoints) ? info.endpoints : [];
        const endpoint = endpoints.find(item => record(item) && typeof item.provider_tag === "string" && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,119}$/.test(item.provider_tag)
          && (rasterFormat(item.supported_parameters) === model!.outputFormat || (modelId === "openai/gpt-image-2" && values(item.supported_parameters, "output_format").length === 0))
          && (!quality || values(item.supported_parameters, "quality").includes(quality)) && (!size || values(item.supported_parameters, "size").includes(size)));
        if (!record(endpoint)) fail("unsupported-model", "No verified raster endpoint supports these image settings.");
        upstreamProvider = String(endpoint.provider_tag);
      }
      const payload: Record<string, unknown> = { model: modelId, prompt: request.prompt, n: 1 };
      if (connection.provider === "openai") Object.assign(payload, { quality, size, output_format: "png" });
      else if (connection.provider === "flux") Object.assign(payload, { size, response_format: "b64_json" });
      else if (connection.provider === "xai") Object.assign(payload, { quality, response_format: "b64_json" });
      else Object.assign(payload, { output_format: model!.outputFormat, provider: { only: [upstreamProvider], allow_fallbacks: false }, ...(quality ? { quality } : {}), ...(size ? { size } : {}) });
      let body: string | FormData; const headers: Record<string, string> = { authorization: `Bearer ${connection.apiKey}` };
      let url = URLS[connection.provider];
      if (request.operation === "edit") {
        const form = new FormData(); for (const [key, value] of Object.entries(payload)) form.append(key, String(value));
        for (let index = 0; index < references.length; index++) { const reference = references[index]!; form.append("image[]", new Blob([new Uint8Array(reference.bytes)], { type: reference.mime }), `reference-${index}.${reference.mime === "image/jpeg" ? "jpg" : reference.mime.slice(6)}`); }
        body = form; url = "https://api.openai.com/v1/images/edits";
      } else { headers["content-type"] = "application/json"; body = JSON.stringify(payload); }
      active();
      try { reservation = await hooks.reserve(details); } catch { fail("permission-denied", "Image generation was not approved."); }
      // The provider deadline starts after the separately bounded owner review.
      signal = hooks.signal ? AbortSignal.any([hooks.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
      active();
      outcome = "uncertain";
      const response = await this.fetcher(url, { method: "POST", headers, body, signal, redirect: "error" });
      if (!response.ok) {
        outcome = response.status >= 400 && response.status < 500 ? "failed" : "uncertain";
        void response.body?.cancel();
        fail("provider-error", `The selected image provider rejected the request (HTTP ${response.status}). No fallback or automatic retry was attempted.`, outcome);
      }
      const result = await boundedJson(response, MAX_RESPONSE_BYTES);
      if (!record(result) || !Array.isArray(result.data) || result.data.length !== 1 || !record(result.data[0]) || typeof result.data[0].b64_json !== "string") fail("invalid-image", "The image provider did not return one supported image.", outcome);
      let image: DecodedGeneratedImage;
      try { image = decodeGeneratedImage(result.data[0].b64_json); } catch { return fail("invalid-image", "The image provider returned invalid or oversized raster bytes.", outcome); }
      const metadata: GeneratedImageMetadata = { ...details, ...(typeof result.model === "string" && result.model.length <= 180 ? { reportedModel: result.model } : {}), ...(upstreamProvider ? { upstreamProvider } : {}), ...(safeUsage(result) ? { usage: safeUsage(result) } : {}) };
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
