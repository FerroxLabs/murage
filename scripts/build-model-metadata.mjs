#!/usr/bin/env node
// Generate src/data/model-metadata.json — the bundled price/capability
// snapshot the model picker reads with the network unplugged.
//
// WHY. `priceBand()` (src/lib/provider-model-picker.ts) turns
// `pricing.outputPerMillion` into "$" / "$$" / "$$$" and falls back to the
// string "Price unavailable". The band was never missing; the NUMBER was.
// Only the openrouter preset's live catalog carries prices
// (server/provider-connections.ts), so every engine model — Claude Opus 5 on
// the Claude engine, every Codex row, every Gemini row — reached the picker
// with no pricing at all and rendered "Price unavailable". Same for
// vision/tools/reasoning and the context window: an engine catalog declares a
// `contextWindow` only when the driver happens to know it.
//
// Sean's decision (2026-09-18): BUNDLED ONLY. No runtime fetch, no "last
// refreshed 9 days ago" state in front of a user, no offline degradation. The
// snapshot is committed, reviewable in a diff, and compiled into the renderer
// bundle by Vite — so it is never read from disk at runtime and cannot be the
// next unlisted-resource crash (electron-builder.yml already ships `dist` as
// `ui`; a Vite-imported JSON lands inside it with no allow-list entry needed).
//
// INPUT — models.dev (https://github.com/anomalyco/models.dev, MIT). The full
// API is 221 providers / 7,846 models / 4.5 MB; trimmed to the seven fields
// below it is 1.5 MB pretty-printed, 1.1 MB as Vite inlines it, 122 KB gzipped
// in the asar. EVERY provider is kept — see PROVIDER_ALLOW_LIST below for why
// the 13-provider allow-list this started as was the wrong trade.
//
// Usage:
//   node scripts/build-model-metadata.mjs            # fetch + write (network)
//   node scripts/build-model-metadata.mjs --check     # verify (NO network)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Where the snapshot lands. Under src/ so Vite inlines it into the renderer
 *  bundle: `dist` is already an extraResources entry (`to: ui`), so no
 *  electron-builder allow-list change is required and no runtime file read
 *  exists to fail in a packaged build. */
export const SNAPSHOT_FILE = "src/data/model-metadata.json";
export const SOURCE_URL = "https://models.dev/api.json";
export const SOURCE_REPOSITORY = "https://github.com/anomalyco/models.dev";
export const SOURCE_LICENSE = "MIT";
export const SNAPSHOT_FORMAT = "murage.model-metadata";
export const SNAPSHOT_VERSION = 1;

/** Which providers to keep. `null` means ALL of them, which is the shipped
 *  setting: a user on OpenRouter or any other broad provider should find
 *  their model priced, not just the first-party ones.
 *
 *  This started as a 13-provider allow-list of what Murage can reach, which cut
 *  the file from 1.5 MB to 133 KB. It was the wrong trade. An `openai-compat`
 *  connection can point at anything, OpenRouter alone re-exposes most of the
 *  field, and a user seeing "Price unavailable" on a model we could have priced
 *  is a worse outcome than 1.1 MB of JSON — which gzips to 122 KB inside the
 *  asar. Keeping everything also REDUCED refusals rather than raising them:
 *  see VENDOR_PROVIDERS in src/lib/model-metadata.ts, which resolves an id
 *  several resellers price differently by preferring the vendor's own rate.
 *
 *  The parameter survives so the tests can build a small catalog. */
export const PROVIDER_ALLOW_LIST = null;

const string = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
/** A price in dollars per million tokens. models.dev states cost in exactly
 *  those units already, so this only bounds it — a negative or absurd number
 *  is dropped rather than rendered as a band. */
const money = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000 ? value : undefined;
const tokens = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 20_000_000 ? Math.round(value) : undefined;

/** One models.dev model row, trimmed to what the picker can show. Field order
 *  is fixed here and nowhere else, which is half of what makes the rendered
 *  file byte-stable; sorted keys are the other half. Absent beats false: a
 *  missing `tools` means "not stated", and the picker must not turn that into
 *  "cannot call tools". */
export function trimModel(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const name = string(row.name, 160);
  if (!name) return null;
  const cost = row.cost && typeof row.cost === "object" ? row.cost : {};
  const inputPerMillion = money(cost.input);
  const outputPerMillion = money(cost.output);
  const modalities = row.modalities && typeof row.modalities === "object" ? row.modalities : {};
  const inputModalities = Array.isArray(modalities.input) ? modalities.input : [];
  const contextWindow = tokens(row.limit && typeof row.limit === "object" ? row.limit.context : undefined);
  return {
    name,
    ...(inputPerMillion === undefined ? {} : { inputPerMillion }),
    ...(outputPerMillion === undefined ? {} : { outputPerMillion }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(inputModalities.includes("image") ? { vision: true } : {}),
    ...(row.tool_call === true ? { tools: true } : {}),
    ...(row.reasoning === true ? { reasoning: true } : {}),
  };
}

/** models.dev's whole API → the trimmed, allow-listed, sorted provider tree. */
export function trimCatalog(api, allow = PROVIDER_ALLOW_LIST) {
  if (!api || typeof api !== "object" || Array.isArray(api)) throw new Error("models.dev payload is not an object");
  const providers = {};
  for (const providerId of [...(allow ?? Object.keys(api))].sort()) {
    const provider = api[providerId];
    if (!provider || typeof provider !== "object") continue;
    const models = {};
    for (const modelId of Object.keys(provider.models ?? {}).sort()) {
      const trimmed = trimModel(provider.models[modelId]);
      if (trimmed) models[modelId] = trimmed;
    }
    if (Object.keys(models).length === 0) continue;
    providers[providerId] = { name: string(provider.name, 80) ?? providerId, models };
  }
  if (Object.keys(providers).length === 0) throw new Error("no allow-listed provider survived the trim");
  return providers;
}

/** A fingerprint of the DATA, independent of formatting. `--check` recomputes
 *  it, so a hand-edited price fails the gate even though the file still parses
 *  and still renders byte-identically. It is an accident gate, not a signature:
 *  anyone editing the file can edit the digest too. That is the same trust
 *  model library/catalog.json has. */
export function digestProviders(providers) {
  return createHash("sha256").update(JSON.stringify(providers)).digest("hex");
}

export function buildSnapshot(api, { fetchedAt, etag, allow = PROVIDER_ALLOW_LIST } = {}) {
  const providers = trimCatalog(api, allow);
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    source: {
      url: SOURCE_URL,
      repository: SOURCE_REPOSITORY,
      license: SOURCE_LICENSE,
      fetchedAt,
      ...(etag ? { etag } : {}),
    },
    digest: digestProviders(providers),
    providers,
  };
}

/** The exact bytes src/data/model-metadata.json must contain. Pretty-printed
 *  on the same reasoning as library/catalog.json: a generated file nobody can
 *  read in a diff rots without anyone noticing. Vite minifies it back down. */
export function renderSnapshot(snapshot) {
  return `${JSON.stringify(snapshot, null, 1)}\n`;
}

/** Re-render a parsed snapshot through the very same pipeline that produced
 *  it, so `--check` needs no network and no second copy of the 4.5 MB input.
 *  Reconstructing rather than re-serialising is the point: an added field, a
 *  reordered key, a model inserted out of order or a value that no longer
 *  survives `trimModel` all change these bytes. */
export function recheckSnapshot(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("snapshot is not an object");
  if (parsed.format !== SNAPSHOT_FORMAT) throw new Error(`snapshot format ${String(parsed.format)} is not ${SNAPSHOT_FORMAT}`);
  if (parsed.version !== SNAPSHOT_VERSION) throw new Error(`snapshot version ${String(parsed.version)} is not ${SNAPSHOT_VERSION}`);
  const source = parsed.source;
  if (!source || typeof source !== "object") throw new Error("snapshot carries no source block");
  if (source.url !== SOURCE_URL) throw new Error(`snapshot source url ${String(source.url)} is not ${SOURCE_URL}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(source.fetchedAt))) throw new Error("snapshot source.fetchedAt is not a YYYY-MM-DD date");
  // The parsed providers are fed back through trimCatalog as if they were the
  // upstream API, which is possible only because the trimmed shape is a subset
  // of models.dev's own: `name` is `name`, and the nested cost/limit/modality
  // fields are re-expanded here so one function still owns the rules.
  const api = {};
  for (const [providerId, provider] of Object.entries(parsed.providers ?? {})) {
    if (!provider || typeof provider !== "object") throw new Error(`provider ${providerId} is not an object`);
    const models = {};
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error(`model ${providerId}/${modelId} is not an object`);
      const extra = Object.keys(model).filter(
        (key) => !["name", "inputPerMillion", "outputPerMillion", "contextWindow", "vision", "tools", "reasoning"].includes(key),
      );
      if (extra.length) throw new Error(`model ${providerId}/${modelId} carries unknown field(s) ${extra.join(", ")}`);
      models[modelId] = {
        name: model.name,
        cost: { input: model.inputPerMillion, output: model.outputPerMillion },
        limit: { context: model.contextWindow },
        modalities: { input: model.vision === true ? ["text", "image"] : ["text"] },
        tool_call: model.tools === true,
        reasoning: model.reasoning === true,
      };
    }
    api[providerId] = { name: provider.name, models };
  }
  const rebuilt = buildSnapshot(api, {
    fetchedAt: source.fetchedAt,
    etag: source.etag,
    allow: Object.keys(parsed.providers ?? {}),
  });
  return {
    rendered: renderSnapshot(rebuilt),
    digestMatches: parsed.digest === rebuilt.digest,
    storedDigest: parsed.digest,
    computedDigest: rebuilt.digest,
  };
}

export function snapshotStats(snapshot) {
  const providers = Object.entries(snapshot.providers);
  const models = providers.flatMap(([, provider]) => Object.values(provider.models));
  return {
    providers: providers.length,
    models: models.length,
    priced: models.filter((model) => model.outputPerMillion !== undefined).length,
    context: models.filter((model) => model.contextWindow !== undefined).length,
    vision: models.filter((model) => model.vision === true).length,
  };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const check = process.argv.includes("--check");
  const file = join(REPO_ROOT, SNAPSHOT_FILE);

  if (check) {
    // NO NETWORK. CI must fail when the committed file is stale or edited, not
    // when models.dev is down — a gate that needs someone else's server up is
    // a gate that goes red for reasons nobody in this repo can fix.
    if (!existsSync(file)) {
      console.error(`${SNAPSHOT_FILE} is missing — run pnpm models:build`);
      process.exit(1);
    }
    const current = readFileSync(file, "utf8");
    const { rendered, digestMatches, storedDigest, computedDigest } = recheckSnapshot(JSON.parse(current));
    const stats = snapshotStats(JSON.parse(current));
    console.log(`providers          ${stats.providers}`);
    console.log(`models             ${stats.models}`);
    console.log(`with a price       ${stats.priced}`);
    console.log(`bytes              ${Buffer.byteLength(current)}`);
    if (current !== rendered) {
      console.error(`${SNAPSHOT_FILE} does not match what scripts/build-model-metadata.mjs renders — run pnpm models:build`);
      process.exit(1);
    }
    if (!digestMatches) {
      console.error(`${SNAPSHOT_FILE} digest ${storedDigest} does not match its contents (${computedDigest}) — run pnpm models:build`);
      process.exit(1);
    }
    console.log(`${SNAPSHOT_FILE} is up to date`);
  } else {
    const response = await fetch(SOURCE_URL, { redirect: "error" });
    if (!response.ok) throw new Error(`${SOURCE_URL} -> HTTP ${response.status}`);
    const etag = response.headers.get("etag") ?? undefined;
    const api = await response.json();
    // The date, not the clock: the snapshot is a statement about a day's prices
    // and a timestamp would make every rebuild a diff.
    const fetchedAt = new Date().toISOString().slice(0, 10);
    const snapshot = buildSnapshot(api, { fetchedAt, etag });
    const rendered = renderSnapshot(snapshot);
    const stats = snapshotStats(snapshot);
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    console.log(`providers          ${stats.providers}`);
    console.log(`models             ${stats.models}`);
    console.log(`with a price       ${stats.priced}`);
    console.log(`with a context     ${stats.context}`);
    console.log(`vision             ${stats.vision}`);
    console.log(`bytes              ${Buffer.byteLength(rendered)}`);
    if (current === rendered) {
      console.log(`${SNAPSHOT_FILE} unchanged`);
    } else {
      writeFileSync(file, rendered);
      console.log(`${SNAPSHOT_FILE} written`);
    }
  }
}
