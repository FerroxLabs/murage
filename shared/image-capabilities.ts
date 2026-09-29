// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
/**
 * One capability model for every image provider (image generation v2, A.1 to
 * A.7). Pure: no network, no file system. The server builds catalogs from it
 * and the renderer reads the same types.
 *
 * Sources for the built-in tables: the 29 Sep 2026 image engine research and
 * the Flux image catalogue contract (0161/IMG2-FLUX-CONTRACT.md) section 5,
 * which matches what Flux Router does today. A Flux catalogue, when the router
 * sends one, replaces the Flux rows (parseFluxImageCatalogue); direct keys
 * always use these tables.
 */

export const IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max"] as const;
export type ImageQuality = typeof IMAGE_QUALITIES[number];
export const IMAGE_FORMATS = ["png", "jpeg", "webp"] as const;
export type ImageFormat = typeof IMAGE_FORMATS[number];
export const IMAGE_RESOLUTIONS = ["small", "standard", "large", "max"] as const;
export type ImageResolution = typeof IMAGE_RESOLUTIONS[number];
export type ImageFit = "nearest" | "exact";

/** Request-size guard for the raw prompt field. Each model's own budget is
 * `maxPromptChars`; this only bounds what the tool accepts at all. */
export const IMAGE_PROMPT_HARD_MAX = 100_000;
/** The budget of a model nobody published one for. */
export const IMAGE_DEFAULT_PROMPT_CHARS = 4_000;
export const IMAGE_NEGATIVE_PROMPT_MAX = 2_000;
export const IMAGE_MAX_COUNT = 10;
/** Pixels each resolution aims for: about 0.5K, 1K, 2K and 4K. */
export const RESOLUTION_PIXELS: Readonly<Record<ImageResolution, number>> = { small: 512 * 512, standard: 1024 * 1024, large: 2048 * 2048, max: 8_294_400 };
/** The tier a Gemini-style ratioTier rule is asked for, per resolution. */
const RESOLUTION_TIER: Readonly<Record<ImageResolution, string>> = { small: "512", standard: "1K", large: "2K", max: "4K" };
const TIER_EDGE: Readonly<Record<string, number>> = { "512": 512, "1K": 1024, "2K": 2048, "4K": 4096 };
/** A delivered shape whose ratio is further than this from the asked one is
 * a different picture, so fit "nearest" refuses it. */
export const IMAGE_RATIO_TOLERANCE = 0.03;
const MIB = 1024 * 1024;
export const IMAGE_REFERENCE_BYTES_DEFAULT = 10 * MIB;
export const IMAGE_REFERENCE_TOTAL_DEFAULT = 20 * MIB;
export const IMAGE_REFERENCE_TOTAL_CEILING = 64 * MIB;
/** Most references any model may take (IMAGE_GENERATION_REFERENCE_MAX in shared/media-assets.ts). */
const REFERENCE_CEILING = 16;

export type SizeRule =
  | { kind: "free"; multiple: number; minRatio: number; maxRatio: number; maxPixels: number; maxEdge: number; minPixels: number; experimentalAbovePixels?: number }
  | { kind: "ratioTier"; ratios: string[]; tiers: string[] }
  | { kind: "list"; sizes: string[] };

export interface ImageModelCapabilities {
  maxPromptChars: number;
  promptBudgetSource: "catalogue" | "built-in" | "default";
  /** Plain words when the budget is Murage's own figure, not the provider's. */
  promptBudgetNote?: string;
  sizeRule: SizeRule;
  /** The size rule in words, for list_image_models and Settings. */
  sizeRuleText: string;
  defaultSize: string;
  qualities: string[];
  defaultQuality?: string;
  qualityMode: "param" | "alias";
  qualityAliases?: Record<string, string>;
  /** Alias ids that serve a size other than the default, per quality
   * (the Flux `-xl` ids today). */
  sizeAliases?: Record<string, Record<string, string>>;
  formats: ImageFormat[];
  maxReferences: number;
  maxReferenceBytes: number;
  maxReferenceBytesTotal: number;
  supports: { edit: boolean; background: boolean; seed: boolean; negative: boolean; n: number; compression: boolean };
  delivery: { stream: boolean; streamEdits: boolean; jobs: boolean; keepaliveSeconds?: number };
  /** Seconds a 1024x1024 render takes, per quality, when known. */
  expectedSeconds?: Record<string, number>;
  /** Flux edits stop at the router after about 90 seconds today. */
  editTimeoutSeconds?: number;
  source: "catalogue" | "built-in";
}

// ─── ratios and sizes ─────────────────────────────────────────────────

export function parsePixels(value: string): { width: number; height: number } | null {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value);
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}
/** "W:H" with whole numbers 1..64 on each side, as the tool takes it. */
export function parseAspectRatio(value: string): { width: number; height: number; ratio: number } | null {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  return width >= 1 && width <= 64 && height >= 1 && height <= 64 ? { width, height, ratio: width / height } : null;
}
const ratioDistance = (a: number, b: number) => Math.abs(Math.log(a / b));
export const ratioWithin = (a: number, b: number, tolerance = IMAGE_RATIO_TOLERANCE) => ratioDistance(a, b) <= Math.log(1 + tolerance);
/** A ratio as the simplest "W:H" within 0.5%, e.g. 0.3333 -> "1:3". */
export function ratioLabel(ratio: number): string {
  for (let height = 1; height <= 64; height++) {
    const width = Math.round(ratio * height);
    if (width >= 1 && Math.abs(width / height - ratio) / ratio <= 0.005) { const g = gcd(width, height); return `${width / g}:${height / g}`; }
  }
  return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`;
}
function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a; }
const fmt = (value: number) => value.toLocaleString("en-US");

export function describeSizeRule(rule: SizeRule): string {
  if (rule.kind === "free") {
    const top = rule.experimentalAbovePixels ? ` Above ${fmt(rule.experimentalAbovePixels)} pixels is experimental.` : "";
    return `Any width and height in multiples of ${rule.multiple}, ratio ${ratioLabel(rule.minRatio)} to ${ratioLabel(rule.maxRatio)}, ${fmt(rule.minPixels)} to ${fmt(rule.maxPixels)} pixels, longest side at most ${rule.maxEdge}.${top}`;
  }
  if (rule.kind === "ratioTier") return `Named ratios ${rule.ratios.join(", ")} at size tiers ${rule.tiers.join(", ")}.`;
  return rule.sizes.length ? `Only these sizes: ${rule.sizes.join(", ")}.` : "The provider's default size only.";
}

export interface ImageSizeRequest {
  aspectRatio?: string;
  resolution?: ImageResolution;
  width?: number;
  height?: number;
  /** Legacy "WxH": the same as width and height with fit nearest. */
  size?: string;
  fit?: ImageFit;
}

export interface ResolvedImageSize {
  /** What was asked, in words: "9:16", "1080x1350", "9:16 large" or "default". */
  asked: string;
  /** free and list: the size sent as `size`. */
  width?: number; height?: number;
  /** ratioTier: sent as aspect_ratio and image_size. */
  aspectRatio?: string; tier?: string;
  /** The render in words: "1536x2736" or "9:16 at 2K". */
  rendered: string;
  /** fit exact: what the render is cropped and resized to here. A ratio
   * alone means the largest centred crop of that ratio. */
  exact?: { width?: number; height?: number; ratio: number };
  /** Above the model's experimental pixel line. */
  experimental?: boolean;
  /** Whether a size parameter is sent at all (a list with no sizes sends none). */
  sendsSize: boolean;
}
export type SizeResolution = { ok: true; size: ResolvedImageSize } | { ok: false; message: string };

function snap(value: number, multiple: number, mode: "round" | "floor" | "ceil"): number {
  return Math.max(multiple, Math[mode](value / multiple) * multiple);
}
/** The legal free-rule pixels nearest to `ratio` at about `area` pixels. */
function freePixels(rule: Extract<SizeRule, { kind: "free" }>, ratio: number, area: number): { width: number; height: number } {
  const target = Math.min(rule.maxPixels, Math.max(rule.minPixels, area));
  let height = Math.sqrt(target / ratio), width = height * ratio;
  const edge = Math.max(width, height);
  if (edge > rule.maxEdge) { width *= rule.maxEdge / edge; height *= rule.maxEdge / edge; }
  let w = snap(width, rule.multiple, "round"), h = snap(height, rule.multiple, "round");
  if (w * h > rule.maxPixels || w > rule.maxEdge || h > rule.maxEdge) { w = snap(width, rule.multiple, "floor"); h = snap(height, rule.multiple, "floor"); }
  if (w * h < rule.minPixels) { w = snap(width, rule.multiple, "ceil"); h = snap(height, rule.multiple, "ceil"); }
  if (freeLegal(rule, w, h)) return { width: w, height: h };
  // Snapping can land just outside the rule (a ratio or pixel edge): walk
  // the grid around it to the legal point nearest the asked ratio, then area.
  let best: { width: number; height: number } | undefined, bestScore = Infinity;
  for (let dw = -8; dw <= 8; dw++) for (let dh = -8; dh <= 8; dh++) {
    const cw = w + dw * rule.multiple, ch = h + dh * rule.multiple;
    if (cw <= 0 || ch <= 0 || !freeLegal(rule, cw, ch)) continue;
    const score = ratioDistance(cw / ch, ratio) * 1e6 + ratioDistance(cw * ch, target);
    if (score < bestScore) { best = { width: cw, height: ch }; bestScore = score; }
  }
  return best ?? { width: w, height: h };
}
function freeLegal(rule: Extract<SizeRule, { kind: "free" }>, width: number, height: number): boolean {
  return width % rule.multiple === 0 && height % rule.multiple === 0 && width * height <= rule.maxPixels && width * height >= rule.minPixels
    && Math.max(width, height) <= rule.maxEdge && width / height >= rule.minRatio - 1e-4 && width / height <= rule.maxRatio + 1e-4;
}

/**
 * Resolves what a bot asked for against one model's size rule. Never widens
 * the rule and never hands back a different shape quietly: fit "nearest"
 * refuses a shape more than 3% off the asked ratio, naming the nearest legal
 * one; fit "exact" renders that nearest shape and marks the crop.
 */
export function resolveImageSize(rule: SizeRule, request: ImageSizeRequest, defaultSize: string): SizeResolution {
  const fit = request.fit ?? "nearest";
  const legacy = request.size !== undefined ? parsePixels(request.size) : null;
  if (request.size !== undefined && !legacy) return { ok: false, message: `The size "${request.size}" is not WIDTHxHEIGHT. Use aspect_ratio and resolution, or width and height.` };
  if (legacy && (request.width !== undefined || request.height !== undefined)) return { ok: false, message: "Give width and height or the older size field, not both." };
  const width = legacy?.width ?? request.width, height = legacy?.height ?? request.height;
  if ((width === undefined) !== (height === undefined)) return { ok: false, message: "Give both width and height, or neither." };
  if (width !== undefined && request.aspectRatio !== undefined) return { ok: false, message: "Give aspect_ratio or width and height, not both." };
  if (width !== undefined && request.resolution !== undefined) return { ok: false, message: "Give resolution or width and height, not both." };
  if (width !== undefined && (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height! < 64 || width > 8192 || height! > 8192)) return { ok: false, message: "Width and height must be whole numbers from 64 to 8,192." };
  const aspect = request.aspectRatio !== undefined ? parseAspectRatio(request.aspectRatio) : null;
  if (request.aspectRatio !== undefined && !aspect) return { ok: false, message: `The aspect ratio "${request.aspectRatio}" is not W:H with whole numbers from 1 to 64, such as 9:16.` };
  const asksNothing = width === undefined && !aspect && request.resolution === undefined;
  const pixels = width !== undefined ? { width, height: height! } : null;
  const ratio = pixels ? pixels.width / pixels.height : aspect ? aspect.ratio : 1;
  const area = pixels ? pixels.width * pixels.height : RESOLUTION_PIXELS[request.resolution ?? "standard"];
  const asked = pixels ? `${pixels.width}x${pixels.height}` : aspect ? `${ratioLabel(aspect.ratio)}${request.resolution ? ` ${request.resolution}` : ""}` : request.resolution ? `${request.resolution} square` : "default";
  // fit exact never enlarges past what the model itself renders at most.
  if (pixels && fit === "exact") {
    const most = largestRender(rule);
    if (most !== undefined && pixels.width * pixels.height > most) return { ok: false, message: `${pixels.width}x${pixels.height} is larger than this model renders (at most ${fmt(most)} pixels). Nothing was sent. Ask for a smaller size.` };
  }
  const exactFor = (renderedRatio: number, renderedPixels?: { width: number; height: number }): ResolvedImageSize["exact"] => {
    if (fit !== "exact") return undefined;
    if (pixels) return renderedPixels && renderedPixels.width === pixels.width && renderedPixels.height === pixels.height ? undefined : { ...pixels, ratio };
    return ratioWithin(renderedRatio, ratio, 0.001) ? undefined : { ratio };
  };
  const tooFar = (nearest: string, reason = "") =>
    ({ ok: false as const, message: `${asked} is not a shape this model renders${reason}. The nearest it can do is ${nearest}. Nothing was sent. Ask for ${nearest}, or send fit: "exact" to render ${nearest} and crop it here to what you asked.` });

  if (rule.kind === "free") {
    if (asksNothing) {
      const fallback = parsePixels(defaultSize) ?? freePixels(rule, 1, RESOLUTION_PIXELS.standard);
      return { ok: true, size: { asked, width: fallback.width, height: fallback.height, rendered: `${fallback.width}x${fallback.height}`, sendsSize: true } };
    }
    const inRange = ratio >= rule.minRatio - 1e-4 && ratio <= rule.maxRatio + 1e-4;
    if (!inRange && fit === "nearest") {
      const nearest = ratioLabel(ratio < rule.minRatio ? rule.minRatio : rule.maxRatio);
      return { ok: false, message: `${ratioLabel(ratio)} is outside this model's ${ratioLabel(rule.minRatio)} to ${ratioLabel(rule.maxRatio)} range. The nearest it can do is ${nearest}. Nothing was sent. Ask for ${nearest}, or send fit: "exact" to render ${nearest} and crop it here.` };
    }
    const renderRatio = Math.min(rule.maxRatio, Math.max(rule.minRatio, ratio));
    const chosen = pixels && freeLegal(rule, pixels.width, pixels.height) ? pixels : freePixels(rule, renderRatio, area);
    const renderedRatio = chosen.width / chosen.height;
    if (fit === "nearest" && !ratioWithin(renderedRatio, ratio)) return tooFar(`${chosen.width}x${chosen.height}`);
    const exact = exactFor(renderedRatio, chosen);
    return { ok: true, size: { asked, width: chosen.width, height: chosen.height, rendered: `${chosen.width}x${chosen.height}`, sendsSize: true,
      ...(rule.experimentalAbovePixels && chosen.width * chosen.height > rule.experimentalAbovePixels ? { experimental: true } : {}), ...(exact ? { exact } : {}) } };
  }

  if (rule.kind === "ratioTier") {
    const named = rule.ratios.flatMap(label => { const parsed = parseAspectRatio(label); return parsed ? [{ label, ratio: parsed.ratio }] : []; });
    if (!named.length || !rule.tiers.length) return { ok: false, message: "This model has no size choices Murage can send." };
    // The older size field always rendered at 1K here; it keeps doing so.
    const wantedTier = legacy ? "1K" : pixels ? tierForEdge(rule.tiers, Math.max(pixels.width, pixels.height)) : RESOLUTION_TIER[request.resolution ?? "standard"];
    const tier = rule.tiers.includes(wantedTier) ? wantedTier : nearestTier(rule.tiers, wantedTier);
    // Nothing asked: no ratio is sent, so the model keeps its own default (an
    // edit keeps its reference's shape).
    if (asksNothing) return { ok: true, size: { asked, tier, rendered: `the model's default ratio at ${tier}`, sendsSize: true } };
    const target = named.reduce((best, item) => ratioDistance(item.ratio, ratio) < ratioDistance(best.ratio, ratio) ? item : best);
    if (fit === "nearest" && !ratioWithin(target.ratio, ratio)) return tooFar(target.label);
    const exact = exactFor(target.ratio);
    return { ok: true, size: { asked, aspectRatio: target.label, tier, rendered: `${target.label} at ${tier}`, sendsSize: true, ...(exact ? { exact } : {}) } };
  }

  const sizes = rule.sizes.flatMap(item => { const parsed = parsePixels(item); return parsed ? [parsed] : []; });
  if (!sizes.length) {
    if (asksNothing) return { ok: true, size: { asked, rendered: "the provider's default size", sendsSize: false } };
    return { ok: false, message: "This model takes no size setting; it renders its own default size. Nothing was sent. Leave the size out." };
  }
  const fallback = parsePixels(defaultSize);
  const pick = asksNothing ? sizes.find(item => fallback && item.width === fallback.width && item.height === fallback.height) ?? sizes[0]!
    : sizes.reduce((best, item) => {
      const a = ratioDistance(item.width / item.height, ratio), b = ratioDistance(best.width / best.height, ratio);
      if (Math.abs(a - b) > 1e-9) return a < b ? item : best;
      return ratioDistance(item.width * item.height, area) < ratioDistance(best.width * best.height, area) ? item : best;
    });
  const pickRatio = pick.width / pick.height;
  if (fit === "nearest" && !asksNothing && !ratioWithin(pickRatio, ratio)) return tooFar(`${pick.width}x${pick.height}`, ` (it offers ${rule.sizes.join(", ")})`);
  // Nothing asked: the model's own size, never a crop (even with fit exact).
  const exact = asksNothing ? undefined : exactFor(pickRatio, pick);
  return { ok: true, size: { asked, width: pick.width, height: pick.height, rendered: `${pick.width}x${pick.height}`, sendsSize: true, ...(exact ? { exact } : {}) } };
}
/** The most pixels one render of this rule can have (a tier renders about its edge squared). */
function largestRender(rule: SizeRule): number | undefined {
  if (rule.kind === "free") return rule.maxPixels;
  if (rule.kind === "ratioTier") { const edges = rule.tiers.map(tier => TIER_EDGE[tier] ?? 0); const edge = Math.max(0, ...edges); return edge ? edge * edge : undefined; }
  const areas = rule.sizes.flatMap(item => { const parsed = parsePixels(item); return parsed ? [parsed.width * parsed.height] : []; });
  return areas.length ? Math.max(...areas) : undefined;
}
function tierForEdge(tiers: string[], edge: number): string {
  const known = tiers.filter(tier => TIER_EDGE[tier]).sort((a, b) => TIER_EDGE[a]! - TIER_EDGE[b]!);
  return known.find(tier => TIER_EDGE[tier]! >= edge) ?? known[known.length - 1] ?? tiers[0]!;
}
function nearestTier(tiers: string[], wanted: string): string {
  const edge = TIER_EDGE[wanted] ?? 1024;
  return tiers.reduce((best, tier) => Math.abs((TIER_EDGE[tier] ?? 0) - edge) < Math.abs((TIER_EDGE[best] ?? 0) - edge) ? tier : best);
}
/** The pixels a fit-exact crop ends at, for one actual render. */
export function exactTarget(exact: NonNullable<ResolvedImageSize["exact"]>, rendered: { width: number; height: number }): { width: number; height: number } {
  if (exact.width && exact.height) return { width: exact.width, height: exact.height };
  const renderedRatio = rendered.width / rendered.height;
  return renderedRatio > exact.ratio
    ? { width: Math.max(1, Math.round(rendered.height * exact.ratio)), height: rendered.height }
    : { width: rendered.width, height: Math.max(1, Math.round(rendered.width / exact.ratio)) };
}

// ─── quality and the id actually sent ──────────────────────────────────

export type SentModel = { ok: true; model: string; quality?: string; sendQuality: boolean } | { ok: false; message: string };
/**
 * The model id to send for one quality and size. `param` models get their
 * own id and a `quality` field; `alias` models get the alias id and no
 * quality field. A combination no alias serves is refused, naming what exists.
 */
export function sentModelFor(id: string, capabilities: ImageModelCapabilities, quality: string | undefined, size: string | undefined): SentModel {
  // A param model sends a quality only when one was asked or it declares a
  // default; an alias model always resolves one (its id names it).
  const q = quality ?? capabilities.defaultQuality ?? (capabilities.qualityMode === "alias" ? capabilities.qualities[0] : undefined);
  if (quality !== undefined && !capabilities.qualities.includes(quality)) {
    return { ok: false, message: capabilities.qualities.length ? `${id} takes quality ${capabilities.qualities.join(", ")}. Nothing was sent.` : `${id} takes no quality setting. Nothing was sent. Leave quality out.` };
  }
  if (capabilities.qualityMode === "param") return { ok: true, model: id, ...(q && capabilities.qualities.length ? { quality: q } : {}), sendQuality: Boolean(q && capabilities.qualities.length) };
  const variants = size ? capabilities.sizeAliases?.[size] : undefined;
  if (variants) {
    const alias = q ? variants[q] : undefined;
    if (!alias) return { ok: false, message: `${size} on ${id} exists only at quality ${Object.keys(variants).join(", ")}. Nothing was sent.` };
    return { ok: true, model: alias, ...(q ? { quality: q } : {}), sendQuality: false };
  }
  const alias = q ? capabilities.qualityAliases?.[q] : undefined;
  return { ok: true, model: alias ?? id, ...(q ? { quality: q } : {}), sendQuality: false };
}

// ─── built-in tables ───────────────────────────────────────────────────

const OPENAI_FREE: SizeRule = { kind: "free", multiple: 16, minRatio: 1 / 3, maxRatio: 3, maxPixels: 8_294_400, maxEdge: 3840, minPixels: 655_360, experimentalAbovePixels: 3_686_400 };
const OPENAI_LIST: SizeRule = { kind: "list", sizes: ["1024x1024", "1536x1024", "1024x1536"] };
const FLUX2_FREE: SizeRule = { kind: "free", multiple: 32, minRatio: 1 / 3, maxRatio: 3, maxPixels: 4_194_304, maxEdge: 4096, minPixels: 65_536 };
const GEMINI_STANDARD_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const NO_SUPPORTS = { edit: false, background: false, seed: false, negative: false, n: 1, compression: false };
const BUFFERED = { stream: false, streamEdits: false, jobs: false };
const NOT_PUBLISHED = "Limit not published, Murage uses 4,000.";

type Built = Omit<ImageModelCapabilities, "sizeRuleText" | "source" | "promptBudgetSource"> & { promptBudgetSource?: ImageModelCapabilities["promptBudgetSource"] };
function finish(value: Built, source: ImageModelCapabilities["source"] = "built-in"): ImageModelCapabilities {
  return { ...value, promptBudgetSource: value.promptBudgetSource ?? "built-in", sizeRuleText: describeSizeRule(value.sizeRule), source };
}
export const OPENAI_IMAGE_MODELS = ["gpt-image-2", "gpt-image-2-2026-04-21", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"] as const;
function openai(id: string): ImageModelCapabilities | null {
  const base = { maxPromptChars: 32_000, qualityMode: "param" as const, formats: [...IMAGE_FORMATS], maxReferences: 16, maxReferenceBytes: IMAGE_REFERENCE_BYTES_DEFAULT, maxReferenceBytesTotal: IMAGE_REFERENCE_TOTAL_CEILING,
    defaultQuality: "medium", defaultSize: "1024x1024", delivery: { stream: true, streamEdits: true, jobs: false } };
  if (id === "gpt-image-2" || id === "gpt-image-2-2026-04-21") return finish({ ...base, sizeRule: OPENAI_FREE, qualities: ["low", "medium", "high"], supports: { edit: true, background: false, seed: false, negative: false, n: 10, compression: true } });
  if (["gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"].includes(id)) return finish({ ...base, sizeRule: OPENAI_LIST, qualities: ["low", "medium", "high"], supports: { edit: true, background: true, seed: false, negative: false, n: 10, compression: true } });
  if (id === "gpt-image-2.5-sunburst" || id === "gpt-image-2.5-flare") return finish({ ...base, sizeRule: OPENAI_FREE, qualities: ["low", "medium", "high", "xhigh", "max"], supports: { edit: true, background: true, seed: false, negative: false, n: 10, compression: true } });
  return null;
}
function google(id: string): ImageModelCapabilities | null {
  const tiers = id === "gemini-3.1-flash-image" ? ["512", "1K", "2K", "4K"] : id === "gemini-3-pro-image" ? ["1K", "2K", "4K"] : id === "gemini-3.1-flash-lite-image" ? ["1K"] : null;
  if (!tiers) return null;
  const ratios = id === "gemini-3.1-flash-image" ? [...GEMINI_STANDARD_RATIOS, "1:4", "4:1", "1:8", "8:1"] : GEMINI_STANDARD_RATIOS;
  return finish({ maxPromptChars: 32_000, promptBudgetNote: "Google counts tokens, not characters; Murage uses a conservative 32,000 characters.",
    sizeRule: { kind: "ratioTier", ratios, tiers }, defaultSize: "1024x1024", qualities: [], qualityMode: "param", formats: ["png"],
    maxReferences: 14, maxReferenceBytes: IMAGE_REFERENCE_BYTES_DEFAULT, maxReferenceBytesTotal: IMAGE_REFERENCE_TOTAL_DEFAULT,
    supports: { ...NO_SUPPORTS, edit: true, seed: true }, delivery: BUFFERED });
}
function xai(id: string): ImageModelCapabilities | null {
  if (id !== "grok-imagine-image-2.0") return null;
  return finish({ maxPromptChars: IMAGE_DEFAULT_PROMPT_CHARS, promptBudgetSource: "default", promptBudgetNote: NOT_PUBLISHED,
    // xAI takes no size today: it renders its own default, and the card says so.
    sizeRule: { kind: "list", sizes: [] }, defaultSize: "1024x1024", qualities: ["low", "medium"], defaultQuality: "low", qualityMode: "param", formats: ["png"],
    maxReferences: 4, maxReferenceBytes: IMAGE_REFERENCE_BYTES_DEFAULT, maxReferenceBytesTotal: IMAGE_REFERENCE_TOTAL_DEFAULT,
    supports: { ...NO_SUPPORTS, edit: true }, delivery: BUFFERED });
}

/** One Flux model family: the base id, its quality aliases and size variants. */
interface FluxFamily { id: string; label: string; qualities: string[]; defaultQuality: string; aliases: Record<string, string>; sizeAliases?: Record<string, Record<string, string>> }
const FLUX_FAMILIES: readonly FluxFamily[] = [
  { id: "flux-image", label: "GPT Image 2.5 Flare high", qualities: ["high"], defaultQuality: "high", aliases: { high: "flux-image" } },
  { id: "flux-image-gpt25", label: "GPT Image 2.5 Flare", qualities: ["low", "medium", "high", "xhigh", "max"], defaultQuality: "medium",
    aliases: { low: "flux-image-gpt25-low", medium: "flux-image-gpt25", high: "flux-image-gpt25-high", xhigh: "flux-image-gpt25-xhigh", max: "flux-image-gpt25-max" },
    sizeAliases: { "1536x1024": { high: "flux-image-gpt25-xl", max: "flux-image-gpt25-max-xl" } } },
  { id: "flux-image-gpt25-sunburst", label: "GPT Image 2.5 Sunburst", qualities: ["low", "medium", "high", "xhigh"], defaultQuality: "high",
    aliases: { low: "flux-image-gpt25-sunburst-low", medium: "flux-image-gpt25-sunburst-med", high: "flux-image-gpt25-sunburst", xhigh: "flux-image-gpt25-sunburst-xhigh" },
    sizeAliases: { "1536x1024": { high: "flux-image-gpt25-sunburst-xl" } } },
  { id: "flux-image-gpt2", label: "GPT Image 2", qualities: ["low", "medium"], defaultQuality: "medium", aliases: { low: "flux-image-gpt2-low", medium: "flux-image-gpt2" } },
];
/** The Flux family base ids (each keeps its own full statement). */
export const FLUX_FAMILY_IDS: ReadonlySet<string> = new Set(FLUX_FAMILIES.map(family => family.id));
/** Each older Flux id: its family and the quality and size it has always
 * meant. Every one keeps working unchanged. */
export const FLUX_LEGACY_IDS: Readonly<Record<string, { base: string; quality: string; size: string }>> = Object.fromEntries(FLUX_FAMILIES.flatMap(family => [
  ...Object.entries(family.aliases).map(([quality, id]) => [id, { base: family.id, quality, size: "1024x1024" }] as const),
  ...Object.entries(family.sizeAliases ?? {}).flatMap(([size, byQuality]) => Object.entries(byQuality).map(([quality, id]) => [id, { base: family.id, quality, size }] as const)),
]));
const FLUX_GPT_BASE = { maxPromptChars: 32_000, formats: ["png" as ImageFormat], maxReferences: 4, maxReferenceBytes: IMAGE_REFERENCE_BYTES_DEFAULT, maxReferenceBytesTotal: IMAGE_REFERENCE_TOTAL_DEFAULT,
  supports: { ...NO_SUPPORTS, edit: true }, delivery: { stream: true, streamEdits: false, jobs: false }, editTimeoutSeconds: 90, qualityMode: "alias" as const, defaultSize: "1024x1024" };
function fluxFamily(family: FluxFamily): ImageModelCapabilities {
  const sizes = ["1024x1024", ...Object.keys(family.sizeAliases ?? {})];
  return finish({ ...FLUX_GPT_BASE, sizeRule: { kind: "list", sizes }, qualities: family.qualities, defaultQuality: family.defaultQuality, qualityAliases: family.aliases,
    ...(family.sizeAliases ? { sizeAliases: family.sizeAliases } : {}) });
}
/** An older Flux id narrowed to the one quality and size it names. */
function fluxLegacy(id: string): ImageModelCapabilities | null {
  const legacy = FLUX_LEGACY_IDS[id];
  if (!legacy) return null;
  return finish({ ...FLUX_GPT_BASE, sizeRule: { kind: "list", sizes: [legacy.size] }, defaultSize: legacy.size, qualities: [legacy.quality], defaultQuality: legacy.quality, qualityAliases: { [legacy.quality]: id } });
}
export const FLUX_EXTRA_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "flux-image-fast", label: "FLUX.2 (fast)" },
  { id: "flux-image-nano-banana-2", label: "Nano Banana 2" },
  { id: "flux-image-lite", label: "Nano Banana 2 Lite" },
];
function fluxExtra(id: string): ImageModelCapabilities | null {
  const common = { defaultSize: "1024x1024", qualities: [], qualityMode: "param" as const, formats: ["png" as ImageFormat], maxReferences: 0,
    maxReferenceBytes: IMAGE_REFERENCE_BYTES_DEFAULT, maxReferenceBytesTotal: IMAGE_REFERENCE_TOTAL_DEFAULT, supports: NO_SUPPORTS, delivery: BUFFERED };
  if (id === "flux-image-fast") return finish({ ...common, maxPromptChars: 2_000, sizeRule: FLUX2_FREE });
  if (id === "flux-image-nano-banana-2" || id === "flux-image-lite") return finish({ ...common, maxPromptChars: 32_000, sizeRule: { kind: "list", sizes: ["1024x1024"] } });
  return null;
}
/** The Flux rows Murage lists with no catalogue: every family base, the new
 * models, and every older id as an alias of its base. */
export function fluxBuiltInModels(): Array<{ id: string; label: string; aliasOf?: string; capabilities: ImageModelCapabilities }> {
  const families = FLUX_FAMILIES.map(family => ({ id: family.id, label: family.label, capabilities: fluxFamily(family) }));
  const extras = FLUX_EXTRA_MODELS.map(model => ({ ...model, capabilities: fluxExtra(model.id)! }));
  const legacy = Object.entries(FLUX_LEGACY_IDS).filter(([id]) => !FLUX_FAMILIES.some(family => family.id === id))
    .map(([id, value]) => ({ id, label: id, aliasOf: value.base, capabilities: fluxLegacy(id)! }));
  return [...families, ...extras, ...legacy];
}

export type ImageCapabilityProvider = "openai" | "flux" | "openrouter" | "xai" | "google";
/** The built-in capabilities for one provider model, or null when Murage has
 * no row for it (OpenRouter's come from its catalogue: openRouterCapabilities). */
export function builtInImageCapabilities(provider: ImageCapabilityProvider, id: string): ImageModelCapabilities | null {
  if (provider === "openai") return openai(id);
  if (provider === "google") return google(id);
  if (provider === "xai") return xai(id);
  if (provider === "flux") {
    const family = FLUX_FAMILIES.find(item => item.id === id);
    return family ? fluxFamily(family) : fluxExtra(id) ?? fluxLegacy(id);
  }
  return null;
}
/** OpenRouter: the live catalogue's sizes and qualities; the budget is
 * OpenAI's for `openai/gpt-image-*`, else the unpublished default. */
export function openRouterCapabilities(id: string, sizes: string[], qualities: string[], maxReferences: number, format: ImageFormat | undefined): ImageModelCapabilities {
  const gpt = id.startsWith("openai/gpt-image-");
  const legal = sizes.filter(size => parsePixels(size));
  return finish({ maxPromptChars: gpt ? 32_000 : IMAGE_DEFAULT_PROMPT_CHARS, promptBudgetSource: gpt ? "built-in" : "default", ...(gpt ? {} : { promptBudgetNote: NOT_PUBLISHED }),
    sizeRule: { kind: "list", sizes: legal }, defaultSize: legal[0] ?? "1024x1024",
    qualities, qualityMode: "param", formats: format ? [format] : ["png"], maxReferences, maxReferenceBytes: IMAGE_REFERENCE_BYTES_DEFAULT, maxReferenceBytesTotal: IMAGE_REFERENCE_TOTAL_DEFAULT,
    supports: { ...NO_SUPPORTS, edit: maxReferences > 0 }, delivery: BUFFERED });
}
/** A model nobody described: the smallest honest promise. */
export function defaultImageCapabilities(defaultSize = "1024x1024", maxReferences = 0): ImageModelCapabilities {
  return finish({ maxPromptChars: IMAGE_DEFAULT_PROMPT_CHARS, promptBudgetSource: "default", promptBudgetNote: NOT_PUBLISHED,
    sizeRule: { kind: "list", sizes: [defaultSize] }, defaultSize, qualities: [], qualityMode: "param", formats: ["png"], maxReferences,
    maxReferenceBytes: IMAGE_REFERENCE_BYTES_DEFAULT, maxReferenceBytesTotal: IMAGE_REFERENCE_TOTAL_DEFAULT, supports: { ...NO_SUPPORTS, edit: maxReferences > 0 }, delivery: BUFFERED });
}

// ─── Flux catalogue (contract section 1) ───────────────────────────────

export interface FluxCatalogueEntry {
  id: string; label: string; aliases: string[]; operations: Array<"generate" | "edit">;
  capabilities: ImageModelCapabilities;
  status?: { state: "ok" | "degraded" | "down"; checkedAt?: string; lastGoodAt?: string };
}
export interface FluxCatalogue { defaultModel?: string; probe: boolean; entries: FluxCatalogueEntry[] }

const rec = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const int = (value: unknown, min: number, max: number): number | undefined => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
const bool = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
const ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const iso = (value: unknown) => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : undefined;

function parseSizeRule(value: unknown): SizeRule | undefined {
  if (!rec(value)) return undefined;
  if (value.kind === "free") {
    const multiple = int(value.multiple, 1, 256), maxPixels = int(value.maxPixels, 4096, 67_108_864), maxEdge = int(value.maxEdge, 64, 16_384), minPixels = int(value.minPixels, 1, 67_108_864);
    const minRatio = typeof value.minRatio === "number" && value.minRatio > 0 && value.minRatio <= 1 ? value.minRatio : undefined;
    const maxRatio = typeof value.maxRatio === "number" && value.maxRatio >= 1 && value.maxRatio <= 64 ? value.maxRatio : undefined;
    if (!multiple || !maxPixels || !maxEdge || !minPixels || !minRatio || !maxRatio || minPixels > maxPixels) return undefined;
    const experimental = int(value.experimentalAbovePixels, 1, maxPixels);
    return { kind: "free", multiple, minRatio, maxRatio, maxPixels, maxEdge, minPixels, ...(experimental ? { experimentalAbovePixels: experimental } : {}) };
  }
  if (value.kind === "ratioTier") {
    const ratios = Array.isArray(value.ratios) ? value.ratios.filter((item): item is string => typeof item === "string" && parseAspectRatio(item) !== null).slice(0, 64) : [];
    const tiers = Array.isArray(value.tiers) ? value.tiers.filter((item): item is string => typeof item === "string" && /^[0-9A-Za-z]{1,8}$/.test(item)).slice(0, 16) : [];
    return ratios.length && tiers.length ? { kind: "ratioTier", ratios, tiers } : undefined;
  }
  if (value.kind === "list") {
    const sizes = Array.isArray(value.sizes) ? value.sizes.filter((item): item is string => typeof item === "string" && parsePixels(item) !== null).slice(0, 128) : [];
    return sizes.length ? { kind: "list", sizes } : undefined;
  }
  return undefined;
}
function qualityList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && (IMAGE_QUALITIES as readonly string[]).includes(item));
  return list.length === value.length ? [...new Set(list)] : undefined;
}

/** One catalogue row over its built-in fallback. Every field is optional; a
 * value outside the contract's range keeps the fallback, never widens it. */
function parseEntry(row: unknown, fallbackFor: (id: string) => ImageModelCapabilities | null): FluxCatalogueEntry | null {
  if (!rec(row) || typeof row.id !== "string" || !ID.test(row.id)) return null;
  const id = row.id;
  const base = fallbackFor(id) ?? defaultImageCapabilities("1024x1024", 4);
  const aliases = Array.isArray(row.aliases) ? row.aliases.filter((item): item is string => typeof item === "string" && ID.test(item) && item !== id).slice(0, 64) : [];
  const operationsRaw = Array.isArray(row.operations) ? row.operations.filter((item): item is "generate" | "edit" => item === "generate" || item === "edit") : [];
  const operations: Array<"generate" | "edit"> = operationsRaw.length ? [...new Set(operationsRaw)] : ["generate"];
  const maxPrompt = int(row.maxPromptChars, 1, IMAGE_PROMPT_HARD_MAX);
  const parsedRule = parseSizeRule(row.sizeRule);
  const sizeRule = parsedRule ?? base.sizeRule;
  const defaultSize = typeof row.defaultSize === "string" && parsePixels(row.defaultSize) ? row.defaultSize : base.defaultSize;
  const qualities = qualityList(row.qualities) ?? base.qualities;
  const aliasMap = rec(row.qualityAliases) ? Object.fromEntries(Object.entries(row.qualityAliases).filter(([quality, alias]) => qualities.includes(quality) && typeof alias === "string" && ID.test(alias))) as Record<string, string> : undefined;
  const hasAliases = Boolean(aliasMap && Object.keys(aliasMap).length);
  const qualityMode = row.qualityMode === "param" || row.qualityMode === "alias" ? row.qualityMode : hasAliases ? "alias" : "param";
  // No stated default never downgrades: the built-in default when it is
  // still offered, else the quality the id itself names, else none (param).
  const selfQuality = aliasMap ? Object.entries(aliasMap).find(([, alias]) => alias === id)?.[0] : undefined;
  const defaultQuality = typeof row.defaultQuality === "string" && qualities.includes(row.defaultQuality) ? row.defaultQuality
    : base.defaultQuality && qualities.includes(base.defaultQuality) ? base.defaultQuality
    : selfQuality ?? (qualityMode === "alias" ? qualities[0] : undefined);
  const formats = Array.isArray(row.formats) ? row.formats.filter((item): item is ImageFormat => (IMAGE_FORMATS as readonly string[]).includes(item as string)) : [];
  const supports = rec(row.supports) ? row.supports : {};
  const delivery = rec(row.delivery) ? row.delivery : {};
  const expected = rec(row.expectedSeconds) ? Object.fromEntries(Object.entries(row.expectedSeconds).filter(([quality, seconds]) => typeof seconds === "number" && seconds > 0 && seconds <= 3600 && (IMAGE_QUALITIES as readonly string[]).includes(quality))) as Record<string, number> : undefined;
  const keepalive = int(delivery.keepaliveSeconds, 1, 300);
  const streamEdits = bool(delivery.streamEdits) ?? false;
  const capabilities = finish({
    maxPromptChars: maxPrompt ?? base.maxPromptChars, promptBudgetSource: maxPrompt ? "catalogue" : base.promptBudgetSource,
    ...(!maxPrompt && base.promptBudgetNote ? { promptBudgetNote: base.promptBudgetNote } : {}),
    sizeRule, defaultSize, qualities, ...(defaultQuality ? { defaultQuality } : {}), qualityMode,
    ...(hasAliases ? { qualityAliases: aliasMap } : qualityMode === "alias" && base.qualityAliases ? { qualityAliases: base.qualityAliases } : {}),
    ...(!parsedRule && base.sizeAliases ? { sizeAliases: base.sizeAliases } : {}),
    formats: formats.length ? [...new Set(formats)] : ["png"],
    maxReferences: int(row.maxReferences, 0, REFERENCE_CEILING) ?? base.maxReferences,
    maxReferenceBytes: int(row.maxReferenceBytes, 1, IMAGE_REFERENCE_TOTAL_CEILING) ?? base.maxReferenceBytes,
    maxReferenceBytesTotal: int(row.maxReferenceBytesTotal, 1, IMAGE_REFERENCE_TOTAL_CEILING) ?? base.maxReferenceBytesTotal,
    supports: { edit: (bool(supports.edit) ?? true) && operations.includes("edit"), background: bool(supports.background) ?? false, seed: bool(supports.seed) ?? false,
      negative: bool(supports.negative) ?? false, n: int(supports.n, 1, IMAGE_MAX_COUNT) ?? 1, compression: bool(supports.compression) ?? false },
    delivery: { stream: bool(delivery.stream) ?? base.delivery.stream, streamEdits, jobs: bool(delivery.jobs) ?? false, ...(keepalive ? { keepaliveSeconds: keepalive } : {}) },
    ...(expected && Object.keys(expected).length ? { expectedSeconds: expected } : {}),
    ...(base.editTimeoutSeconds && !streamEdits ? { editTimeoutSeconds: base.editTimeoutSeconds } : {}),
  }, "catalogue");
  const statusRaw = rec(row.status) ? row.status : undefined;
  const state = statusRaw && (statusRaw.state === "ok" || statusRaw.state === "degraded" || statusRaw.state === "down") ? statusRaw.state : undefined;
  const checkedAt = iso(statusRaw?.checked_at), lastGoodAt = iso(statusRaw?.last_good_at);
  return { id, label: catalogueLabel(row.label) ?? id, aliases, operations, capabilities,
    ...(state ? { status: { state, ...(checkedAt ? { checkedAt } : {}), ...(lastGoodAt ? { lastGoodAt } : {}) } } : {}) };
}

/** A router label shown in Settings and to bots: control, format (bidi,
 * zero-width) and markup characters removed, one line, at most 80. */
function catalogueLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.replace(/[\p{Cc}\p{Cf}<>\[\]`]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return label || undefined;
}

/** The contract body, or null for anything else ("old router"). A malformed
 * entry is skipped, never the whole catalogue. */
export function parseFluxImageCatalogue(payload: unknown): FluxCatalogue | null {
  if (!rec(payload) || payload.contract !== 1 || payload.kind !== "image-catalogue" || !Array.isArray(payload.data)) return null;
  const seen = new Set<string>(); const entries: FluxCatalogueEntry[] = [];
  for (const row of payload.data.slice(0, 500)) {
    const entry = parseEntry(row, id => builtInImageCapabilities("flux", id));
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id); entries.push(entry);
  }
  const defaultModel = typeof payload.default_model === "string" && entries.some(entry => entry.id === payload.default_model) ? payload.default_model : undefined;
  return { ...(defaultModel ? { defaultModel } : {}), probe: payload.probe === true, entries };
}

// ─── prompt budget ─────────────────────────────────────────────────────

/** The prompt exactly as sent: saved blocks (phase 2 fills `blocks`), the
 * scene, and an Avoid: line when the model has no native negative prompt.
 * Nothing is ever cut. */
export function assembleImagePrompt(input: { blocks?: readonly string[]; scene?: string; negative?: string; nativeNegative: boolean }): { prompt: string; avoidLine: boolean } {
  const parts = [...(input.blocks ?? []), input.scene ?? ""].map(part => part.trim()).filter(Boolean);
  const negative = input.negative?.trim();
  const avoidLine = Boolean(negative && !input.nativeNegative);
  const prompt = parts.join("\n\n") + (avoidLine ? `\n\nAvoid: ${negative}` : "");
  return { prompt: prompt.trim(), avoidLine };
}
export function promptTooLongMessage(chars: number, model: string, allowed: number, fits: readonly string[]): string {
  const alternatives = fits.length ? `, or choose a model with a larger budget: ${fits.slice(0, 3).join(", ")}` : ". No other model on this connection takes that many";
  return `The prompt is ${fmt(chars)} characters; ${model} allows ${fmt(allowed)}. Nothing was sent. Condense it (identity first, then camera, scene, and one short Avoid: line) and send it with condensed_from_chars${alternatives}.`;
}
