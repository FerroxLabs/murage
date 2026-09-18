import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROVIDER_ALLOW_LIST,
  REPO_ROOT,
  SNAPSHOT_FILE,
  buildSnapshot,
  digestProviders,
  recheckSnapshot,
  renderSnapshot,
  snapshotStats,
  trimCatalog,
  trimModel,
} from "./build-model-metadata.mjs";

const committed = readFileSync(join(REPO_ROOT, SNAPSHOT_FILE), "utf8");

/** One provider's worth of models.dev, shaped exactly as the API shapes it. */
const API = {
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-opus-5": {
        name: "Claude Opus 5",
        description: "dropped",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        tool_call: true,
        reasoning: true,
        limit: { context: 500_000, output: 64_000 },
      },
      "claude-text-only": { name: "Text Only", cost: { input: 1 }, modalities: { input: ["text"] }, tool_call: false },
    },
  },
  "not-allow-listed": { name: "Nope", models: { x: { name: "X", cost: { input: 1, output: 1 } } } },
};

describe("trimModel", () => {
  it("keeps the seven fields and drops everything else", () => {
    expect(trimModel(API.anthropic.models["claude-opus-5"])).toEqual({
      name: "Claude Opus 5",
      inputPerMillion: 5,
      outputPerMillion: 25,
      contextWindow: 500_000,
      vision: true,
      tools: true,
      reasoning: true,
    });
  });

  it("maps vision from the input modalities, not from a flag", () => {
    expect(trimModel({ name: "a", modalities: { input: ["text", "image"] } }).vision).toBe(true);
    expect(trimModel({ name: "a", modalities: { input: ["text", "pdf"] } }).vision).toBeUndefined();
    expect(trimModel({ name: "a" }).vision).toBeUndefined();
  });

  it("omits a capability rather than asserting false", () => {
    // Absent means "upstream did not say". A false would let the picker claim
    // a model cannot call tools when nobody ever checked.
    const trimmed = trimModel(API.anthropic.models["claude-text-only"]);
    expect(trimmed).toEqual({ name: "Text Only", inputPerMillion: 1 });
    expect("tools" in trimmed).toBe(false);
    expect("outputPerMillion" in trimmed).toBe(false);
  });

  it("refuses a row with no name or no shape", () => {
    expect(trimModel(null)).toBeNull();
    expect(trimModel([])).toBeNull();
    expect(trimModel({ cost: { input: 1 } })).toBeNull();
  });

  it("drops a price that is not a price", () => {
    expect(trimModel({ name: "a", cost: { input: -1, output: "3" } })).toEqual({ name: "a" });
    expect(trimModel({ name: "a", limit: { context: 0 } })).toEqual({ name: "a" });
  });
});

describe("trimCatalog", () => {
  it("keeps only the allow-listed providers", () => {
    // The API carries a provider the allow-list does not name; it must not
    // survive, which is what takes the snapshot from ~900 KB to ~133 KB.
    expect(Object.keys(API)).toContain("not-allow-listed");
    expect(Object.keys(trimCatalog(API, ["anthropic"]))).toEqual(["anthropic"]);
  });
  it("throws rather than writing an empty snapshot", () => {
    expect(() => trimCatalog(API, ["nothing-here"])).toThrow(/no allow-listed provider/);
    expect(() => trimCatalog(null)).toThrow(/not an object/);
  });
  it("ships every provider, because a missing price is a worse bug than a big file", () => {
    // Sean, 2026-09-18. The 13-provider allow-list this started as saved 1.4 MB
    // and cost coverage on every gateway an openai-compat connection can reach.
    expect(PROVIDER_ALLOW_LIST).toBeNull();
    expect(Object.keys(trimCatalog(API))).toEqual(["anthropic", "not-allow-listed"]);
  });
});

describe("determinism", () => {
  it("renders byte-identically from the same input", () => {
    const once = renderSnapshot(buildSnapshot(API, { fetchedAt: "2026-09-18", etag: "e", allow: ["anthropic"] }));
    const twice = renderSnapshot(buildSnapshot(API, { fetchedAt: "2026-09-18", etag: "e", allow: ["anthropic"] }));
    expect(once).toBe(twice);
    expect(once.endsWith("\n")).toBe(true);
  });

  it("sorts providers and models regardless of the order they arrived in", () => {
    const forward = { a: { name: "a", models: { z: { name: "Z" }, m: { name: "M" } } }, b: { name: "b", models: { q: { name: "Q" } } } };
    const backward = { b: { name: "b", models: { q: { name: "Q" } } }, a: { name: "a", models: { m: { name: "M" }, z: { name: "Z" } } } };
    const render = (api) => renderSnapshot(buildSnapshot(api, { fetchedAt: "2026-09-18", allow: ["b", "a"] }));
    expect(render(forward)).toBe(render(backward));
    expect(Object.keys(buildSnapshot(forward, { fetchedAt: "2026-09-18", allow: ["b", "a"] }).providers)).toEqual(["a", "b"]);
  });

  it("changes its digest when any value changes", () => {
    const base = trimCatalog(API, ["anthropic"]);
    const edited = structuredClone(base);
    edited.anthropic.models["claude-opus-5"].outputPerMillion = 3;
    expect(digestProviders(edited)).not.toBe(digestProviders(base));
  });
});

describe("--check, offline", () => {
  it("accepts the committed snapshot", () => {
    const { rendered, digestMatches } = recheckSnapshot(JSON.parse(committed));
    expect(rendered).toBe(committed);
    expect(digestMatches).toBe(true);
  });

  it("catches a hand-edited price even though the file still parses", () => {
    // The bytes still render identically — a plausible edit keeps the shape —
    // so the digest is what catches it.
    const edited = JSON.parse(committed);
    edited.providers.anthropic.models["claude-opus-5"].outputPerMillion = 1;
    const { rendered, digestMatches } = recheckSnapshot(edited);
    expect(rendered).not.toBe(committed);
    expect(digestMatches).toBe(false);
  });

  it("catches a hand-edited digest", () => {
    const edited = JSON.parse(committed);
    edited.digest = "0".repeat(64);
    expect(recheckSnapshot(edited).digestMatches).toBe(false);
  });

  it("catches a reordered or reformatted file", () => {
    const edited = JSON.parse(committed);
    const models = edited.providers.anthropic.models;
    edited.providers.anthropic.models = Object.fromEntries(Object.entries(models).reverse());
    expect(recheckSnapshot(edited).rendered).toBe(committed); // re-sorted back…
    expect(`${JSON.stringify(edited, null, 1)}\n`).not.toBe(committed); // …which is the point
  });

  it("refuses a snapshot that is not one", () => {
    expect(() => recheckSnapshot(null)).toThrow(/not an object/);
    expect(() => recheckSnapshot({ ...JSON.parse(committed), format: "other" })).toThrow(/format/);
    expect(() => recheckSnapshot({ ...JSON.parse(committed), version: 2 })).toThrow(/version/);
    const badDate = JSON.parse(committed);
    badDate.source = { ...badDate.source, fetchedAt: "soon" };
    expect(() => recheckSnapshot(badDate)).toThrow(/fetchedAt/);
    const extra = JSON.parse(committed);
    extra.providers.anthropic.models["claude-opus-5"].smuggled = true;
    expect(() => recheckSnapshot(extra)).toThrow(/unknown field/);
  });
});

describe("the committed snapshot", () => {
  it("is the size the bundle decision was made on", () => {
    const stats = snapshotStats(JSON.parse(committed));
    expect(stats.providers).toBeGreaterThan(200);
    expect(stats.models).toBeGreaterThan(7000);
    expect(stats.priced / stats.models).toBeGreaterThan(0.9);
    // 1.6 MB on disk, 1.1 MB as Vite inlines it, 122 KB gzipped in the asar.
    // The ceiling is a tripwire on an upstream that suddenly doubles, not a
    // budget anyone is defending.
    expect(Buffer.byteLength(committed)).toBeLessThan(3_000_000);
  });
});
