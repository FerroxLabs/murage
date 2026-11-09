// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serviceIdentity, stampService } from "./provider-service.ts";
import type { ProviderErrorInfo } from "./provider-error.ts";

const base: ProviderErrorInfo = { kind: "payment", httpStatus: 402 };

describe("stampService (ERRORS-NAME-THE-SERVICE)", () => {
  it("keeps the engine that ran the turn and the saved AI service it went through, as short identifiers only", () => {
    expect(stampService(base, { engine: "grokAgent" })).toEqual({ ...base, engine: "grokAgent" });
    expect(stampService(base, { engine: "codex", preset: "chatgpt", signIn: true })).toEqual({ ...base, engine: "codex", connection: { preset: "chatgpt", signIn: true } });
    expect(stampService(base, { engine: "openai-compat", preset: "openai", signIn: false })).toEqual({ ...base, engine: "openai-compat", connection: { preset: "openai" } });
  });
  it("never stamps a key, URL, label or anything that is not an identifier", () => {
    for (const bad of ["sk-live key", "https://x.ai/", "a".repeat(41), "", 42, null, undefined, { toString: () => "grokAgent" }]) {
      expect(stampService(base, { engine: bad, preset: bad })).toEqual(base);
    }
  });
});

describe("serviceIdentity", () => {
  it("names Sean's Grok CLI as his own xAI sign-in with xAI's billing page", () => {
    expect(serviceIdentity({ engine: "grokAgent" })).toEqual({ name: "Grok (xAI)", account: "own-sign-in", billingUrl: "https://console.x.ai/" });
  });
  it("a saved AI service wins over the engine, and a plan sign-in is the owner's own sign-in", () => {
    expect(serviceIdentity({ engine: "openai-compat", connection: { preset: "openai" } })?.account).toBe("own-key");
    expect(serviceIdentity({ engine: "codex", connection: { preset: "chatgpt", signIn: true } })).toMatchObject({ name: "ChatGPT", account: "own-sign-in" });
  });
  it("Flux's own reply, or a Flux connection, is the Flux plan", () => {
    expect(serviceIdentity({ engine: "fuigoAgent", provider: "flux-router" })).toMatchObject({ name: "Flux Router", account: "flux" });
    expect(serviceIdentity({ engine: "grokAgent", connection: { preset: "flux" } })).toMatchObject({ account: "flux" });
    expect(serviceIdentity({ engine: "fuigoAgent" })).toEqual({ name: "Fuigo" });
  });
  it("every billing page is plain https with nothing personal in it", () => {
    const engines = ["fuigoAgent", "claudeAgent", "codex", "grokAgent", "grok", "geminiAgent", "antigravityAgent", "qwenAgent", "kimiAgent", "cursorAgent", "droidAgent", "copilotAgent", "openclawAgent", "opencodeGo", "hermesAgent", "clineAgent", "piAgent", "minimax"];
    const presets = ["openai", "anthropic", "xai", "openrouter", "deepseek", "mistral", "groq", "requesty", "google", "chatgpt", "supergrok"];
    const urls = [...engines.map(engine => serviceIdentity({ engine })), ...presets.map(preset => serviceIdentity({ connection: { preset } }))]
      .map(service => { expect(service?.name).toBeTruthy(); return service?.billingUrl; }).filter((url): url is string => Boolean(url));
    expect(urls.length).toBeGreaterThan(6);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.username + parsed.password + parsed.search + parsed.hash).toBe("");
    }
  });
  it("unknown or inherited names are not a service", () => {
    for (const engine of ["evilAgent", "__proto__", "constructor", "hasOwnProperty"]) expect(serviceIdentity({ engine })).toBeUndefined();
    expect(serviceIdentity({ connection: { preset: "__proto__" } })).toBeUndefined();
    expect(serviceIdentity(undefined)).toBeUndefined();
  });
});

it("the server stamps every recorded provider error with the engine that ran the turn", () => {
  const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const start = source.indexOf('case "runtime.error": {');
  const block = source.slice(start, source.indexOf("break;", start));
  expect(block).toContain("stampService(clampProviderSaid(event.providerError), {");
  expect(block).toContain("engine: event.provider");
  expect(block).toContain("...(providerError ? { providerError } : {})");
  expect(block).not.toContain("providerError: event.providerError");
});
