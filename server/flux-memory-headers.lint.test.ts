// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lint: no Flux-routed call site without a Flux Memory headers decision
// (PROPOSAL-v2 5.4). A source file that reaches api.fluxrouter.ai must either
// import flux-memory-headers.ts, or be listed here with the reason it does not
// make a Flux request itself. Adding a call site without deciding its headers
// fails this test.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FLUX_CALL_SITES, type FluxCallSiteId } from "./flux-memory-headers.ts";

const SERVER = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "testing" ? [] : sources(path);
    return /\.(ts|mjs)$/.test(entry.name) && !/\.(test|spec)\.|\.d\.ts$|\.fixture\./.test(entry.name) ? [path] : [];
  });
}

/** Names a Flux endpoint or the key, or mentions Flux in a file that makes HTTP or socket calls. */
const REACHES_FLUX = (text: string): boolean =>
  /api\.fluxrouter\.ai|FLUX_OPENAI_BASE|FLUX_RESPONSES_BASE|FLUX_ANTHROPIC_BASE|\bfluxKey\(/.test(text)
  || (/flux/i.test(text) && /fetch\(|fetchImpl|fetcher|\.fetch\b|new WebSocket|WebSocket\(/.test(text));
const DECIDES = /flux-memory-(headers|wire)/;

/** Files that mention Flux but make no Flux model request of their own, and why. */
const NO_REQUEST_OF_THEIR_OWN: Record<string, string> = {
  "flux-config.ts": "reads the key",
  "flux-usage-tags.ts": "the usage tag values and the Flux host rule; makes no request",
  "opencode-config.ts": "connector plan for opencode.json; the headers ride the per-turn OPENCODE_CONFIG_CONTENT (drivers/acp/opencode-go.ts)",
  "announcements.ts": "a comment; announcements are fetched from Ferrox, not Flux",
  "model-gateway.ts": "a comment; the local gateway never falls back to Flux",
  "drivers/agents-proxy.ts": "a tool description",
  "drivers/codex-catalog.ts": "spawns the codex app-server for its catalog; no Flux request",
  "tts/elevenlabs.ts": "ElevenLabs; mentions Flux in a comment",
  "provider-connections.ts": "catalog GET /v1/models for named connections: no model turn, nothing to capture or recall",
  "composio.ts": "tool-broker health and mounts (api.fluxrouter.ai/composio): no model turn; the token calls go through flux-composio-dev-token.ts",
  "voice/stream-route.ts": "the page-facing route; the Flux socket is opened by voice/flux-stream.ts",
  "voice/transcribe-route.ts": "the page-facing route; the request is made by voice/flux-voice.ts",
  "decider/index.ts": "wiring; the request is made by decider/flux.ts",
  "index.ts": "wiring: passes the key to the modules above and to the engines, makes no Flux request itself",
  "memory/extractor-connections.ts": "hands FLUX_OPENAI_BASE to memory/extract.ts, which calls fluxCallHeaders('memory-extraction')",
  "flux-key-health.ts": "key validity GET /key/info: no model turn, nothing to capture or recall",
  "email/email-secrets.ts": "bot email key storage; names fluxKey() in a comment, makes no request",
  "email/flux-email-client.ts": "bot email /v1/email/* (BOT-EMAIL-MURAGE-109): inbox, send and read routes, no model turn, nothing to capture or recall",
  "email/runtime.ts": "bot email wiring: hands the Flux base to email/flux-email-client.ts, makes no request itself",
};
/** Call-site ids whose code is owned by another lane. They may be unused until that lane lands. */
const PENDING_OTHER_LANE: readonly FluxCallSiteId[] = [];

const files = sources(SERVER).map((path) => ({ rel: relative(SERVER, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));

describe("every Flux-routed call site decides its memory headers", () => {
  const reaching = files.filter((file) => REACHES_FLUX(file.text) && file.rel !== "flux-memory-headers.ts");

  it("imports the headers decision, or is listed as making no request", () => {
    const undecided = reaching.filter((file) => !DECIDES.test(file.text) && !(file.rel in NO_REQUEST_OF_THEIR_OWN)).map((file) => file.rel);
    expect(undecided, "these files reach Flux without a Flux Memory headers decision").toEqual([]);
  });

  it("keeps the allow-list honest: a listed file still exists and still mentions Flux", () => {
    const names = new Set(reaching.map((file) => file.rel));
    const stale = Object.keys(NO_REQUEST_OF_THEIR_OWN).filter((name) => !names.has(name));
    expect(stale, "remove these from NO_REQUEST_OF_THEIR_OWN").toEqual([]);
  });

  it("uses every direct call-site id somewhere in the source, except the ones another lane owns", () => {
    const unused = (Object.keys(FLUX_CALL_SITES) as FluxCallSiteId[])
      .filter((id) => !PENDING_OTHER_LANE.includes(id))
      .filter((id) => !files.some((file) => file.rel !== "flux-memory-headers.ts" && new RegExp(`["'\`]${id}["'\`]`).test(file.text)));
    expect(unused).toEqual([]);
  });
});

describe("headers Murage must never send", () => {
  it("never names x-flux-memory-scope or the required flag outside the guard that refuses them", () => {
    const offenders = files
      .filter((file) => file.rel !== "flux-memory-headers.ts")
      .filter((file) => /x-flux-memory-scope|x-flux-memory-required/i.test(file.text))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it("never sends a memory envelope with required", () => {
    const offenders = files.filter((file) => /flux_memory[\s\S]{0,200}required\s*:\s*true/.test(file.text)).map((file) => file.rel);
    expect(offenders).toEqual([]);
  });
});

describe("runs under Node's type stripping", () => {
  it("flux-memory-headers.ts uses no parameter property, enum or namespace (the server process cannot transform them)", () => {
    const text = files.find((file) => file.rel === "flux-memory-headers.ts")!.text;
    expect(text).not.toMatch(/constructor\([^)]*\b(private|public|protected|readonly)\s/);
    expect(text).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
    expect(text).not.toMatch(/^\s*(export\s+)?namespace\s/m);
  });
});

describe("stays out of the browser bundle", () => {
  it("flux-routing.ts (read by the model picker in src/lib/model-metadata.ts) reaches no node: module through the memory headers", () => {
    const routing = files.find((file) => file.rel === "flux-routing.ts")!.text;
    const imports = [...routing.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((match) => match[1]);
    expect(imports.sort()).toEqual(["./contracts.ts", "./flux-memory-wire.ts"]);
    const wire = files.find((file) => file.rel === "flux-memory-wire.ts")!.text;
    const code = wire.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/^\s*import\s|require\(|node:/m);
  });
});

// USAGE-TAGS (1.0.10): every Flux request carries x-flux-feature (and the bot and conversation when known). A file that reaches Flux
// either tags its requests (through flux-usage-tags.ts or the flux-memory-headers.ts helpers that add the tags) or is listed here
// with the reason it makes no request of its own, or the reason its requests cannot be tagged.
const TAGS_USAGE = /flux-usage-tags|fluxCallHeaders|fluxFetch\(|withFluxCallHeaders|fluxTurnDecision|fluxMemorySend|fluxMemoryAtSend/;
const USAGE_NOT_TAGGED_HERE: Record<string, string> = {
  "flux-contract-endpoints.ts": "the endpoint registry for the daily contract probe; makes no request",
  "flux-routing.ts": "routing tables and the codex provider argv; makes no request",
  "flux-config.ts": "reads the key",
  "opencode-config.ts": "connector plan; the tags ride OPENCODE_CONFIG_CONTENT from acp/core.ts fluxTurnDecision",
  "announcements.ts": "a comment; announcements are fetched from Ferrox, not Flux",
  "model-gateway.ts": "a comment; the local gateway never falls back to Flux",
  "drivers/agents-proxy.ts": "a tool description",
  "drivers/codex-catalog.ts": "spawns the codex app-server for its catalog; no Flux request",
  "drivers/acp/fuigo.ts": "renders decision.headers, which acp/core.ts builds with fluxTurnDecision (tagged)",
  "drivers/acp/qwen.ts": "renders decision.headers, which acp/core.ts builds with fluxTurnDecision (tagged)",
  "drivers/acp/opencode-go.ts": "renders decision.headers, which acp/core.ts builds with fluxTurnDecision (tagged)",
  "memory/extractor-connections.ts": "hands FLUX_OPENAI_BASE to memory/extract.ts, which tags with fluxCallHeaders('memory-extraction')",
  "voice/stream-route.ts": "the page-facing route; voice/flux-stream.ts opens the tagged Flux socket",
  "voice/transcribe-route.ts": "the page-facing route; voice/flux-voice.ts makes the tagged request",
  "decider/index.ts": "wiring; decider/flux.ts makes the tagged request",
  "tts/elevenlabs.ts": "ElevenLabs; mentions Flux in a comment",
  "email/runtime.ts": "wiring; email/flux-email-client.ts makes the tagged requests",
  "email/email-secrets.ts": "bot email key storage; makes no request",
};

describe("every Flux request carries the usage tags", () => {
  const reaching = files.filter((file) => REACHES_FLUX(file.text) && file.rel !== "flux-memory-headers.ts" && file.rel !== "flux-usage-tags.ts");

  it("tags its requests, or is listed with the reason it does not", () => {
    const untagged = reaching.filter((file) => !TAGS_USAGE.test(file.text) && !(file.rel in USAGE_NOT_TAGGED_HERE)).map((file) => file.rel);
    expect(untagged, "these files reach Flux without the usage tags").toEqual([]);
  });

  it("keeps the list honest: a listed file still reaches Flux and still does not tag", () => {
    const names = new Map(reaching.map((file) => [file.rel, file]));
    const stale = Object.keys(USAGE_NOT_TAGGED_HERE).filter((name) => !names.has(name) || TAGS_USAGE.test(names.get(name)!.text));
    expect(stale, "remove these from USAGE_NOT_TAGGED_HERE").toEqual([]);
  });

  it("flux-usage-tags.ts uses no parameter property, enum or namespace (the server process cannot transform them)", () => {
    const text = files.find((file) => file.rel === "flux-usage-tags.ts")!.text;
    expect(text).not.toMatch(/constructor\([^)]*\b(private|public|protected|readonly)\s/);
    expect(text).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m);
  });
});
