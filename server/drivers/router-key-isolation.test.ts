// SPDX-License-Identifier: AGPL-3.0-or-later
// Opus gate 0.1.62-A, upstream #2053/#2107: the shared router key must never
// reach an instance that brings its own endpoint or key variable. Murage keeps
// the workspace key in process.env too (loadConfig prefers env, and
// syncCredentialEnv writes every saved key there), so skipping the injection
// in instanceConfigs() is not enough while the driver still falls back to
// process.env for the workspace variable. These tests drive the real
// instanceConfigs() -> driver.create() path and read the Authorization header
// each request carries.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, instanceConfigs, type AppConfig } from "../config.ts";
import type { ProviderDriver, ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { GrokDriver } from "./grok.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const WORKSPACE_URL = "http://127.0.0.1:8/v1";
const OWN_URL = "http://127.0.0.1:9/v1";
const ROUTER_KEY = "workspace-router-key";
const XAI_KEY = "workspace-xai-key";

const sse = () => new Response(
  [`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`, "data: [DONE]", ""].join("\n"),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

describe("shared router key stays on the workspace endpoint", () => {
  const saved = { compatKey: process.env.OPENAI_COMPAT_API_KEY, compatUrl: process.env.OPENAI_COMPAT_URL, xai: process.env.XAI_API_KEY, own: process.env.GATE_A_OWN_KEY };
  let previousFetch: typeof globalThis.fetch;
  let calls: Array<{ url: string; auth: string | null }>;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    process.env.FAKE_GROK_RETRY_SCALE = "0.001";
    // What the desktop shell injects at boot and syncCredentialEnv() writes on save.
    process.env.OPENAI_COMPAT_API_KEY = ROUTER_KEY;
    process.env.OPENAI_COMPAT_URL = WORKSPACE_URL;
    process.env.XAI_API_KEY = XAI_KEY;
    delete process.env.GATE_A_OWN_KEY;
    previousFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return sse();
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = previousFetch;
    delete process.env.FAKE_GROK_RETRY_SCALE;
    for (const [name, value] of [["OPENAI_COMPAT_API_KEY", saved.compatKey], ["OPENAI_COMPAT_URL", saved.compatUrl], ["XAI_API_KEY", saved.xai], ["GATE_A_OWN_KEY", saved.own]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
  });

  const cfg = {
    openaiCompat: { key: ROUTER_KEY, url: WORKSPACE_URL },
    xai: { key: XAI_KEY, url: WORKSPACE_URL },
    instances: {
      openaiCompat: { driver: "openai-compat" },
      compatOwnUrl: { driver: "openai-compat", config: { url: OWN_URL } },
      compatOwnKeyVar: { driver: "openai-compat", config: { url: OWN_URL, apiKeyEnv: "GATE_A_OWN_KEY" } },
      grokWorkspace: { driver: "grok", config: { url: WORKSPACE_URL } },
      grokOwnUrl: { driver: "grok", config: { url: OWN_URL } },
    },
  } as unknown as AppConfig;

  const turn = async (driver: ProviderDriver<unknown>, id: string) => {
    const entry = instanceConfigs(cfg)[id]!;
    instance = await driver.create({
      instanceId: id,
      displayName: id,
      enabled: true,
      environment: entry.environment ?? {},
      config: driver.decodeConfig(entry.config),
    });
    recorder = recordEvents(instance.adapter);
    // With no key of its own an instance may refuse the turn outright ("no
    // key yet"): that is the right outcome, and nothing was sent.
    const started = await instance.adapter.sendTurn({ threadId: `t-${id}`, text: "hi", model: "gate-a-model" }).then(() => true, () => false);
    if (started) await recorder.until((e) => e.type === "turn.completed");
    return calls;
  };

  it("an OpenAI-compatible instance on the workspace endpoint still uses the workspace key", async () => {
    const seen = await turn(OpenAICompatDriver as ProviderDriver<unknown>, "openaiCompat");
    expect(seen.some((call) => call.url.startsWith(WORKSPACE_URL) && call.auth === `Bearer ${ROUTER_KEY}`)).toBe(true);
  }, 20_000);

  it("an OpenAI-compatible instance with its own URL never sends the workspace key, even from process.env", async () => {
    const seen = await turn(OpenAICompatDriver as ProviderDriver<unknown>, "compatOwnUrl");
    expect(seen.map((call) => call.auth)).not.toContain(`Bearer ${ROUTER_KEY}`);
  }, 20_000);

  it("an OpenAI-compatible instance with its own key variable reads only that variable", async () => {
    const seen = await turn(OpenAICompatDriver as ProviderDriver<unknown>, "compatOwnKeyVar");
    expect(seen.map((call) => call.auth)).not.toContain(`Bearer ${ROUTER_KEY}`);
  }, 20_000);

  it("a Grok API instance on the workspace endpoint still uses the workspace xAI key", async () => {
    const seen = await turn(GrokDriver as ProviderDriver<unknown>, "grokWorkspace");
    expect(seen.some((call) => call.auth === `Bearer ${XAI_KEY}`)).toBe(true);
  }, 20_000);

  it("a Grok API instance with its own URL never sends the workspace xAI key, even from process.env", async () => {
    const seen = await turn(GrokDriver as ProviderDriver<unknown>, "grokOwnUrl");
    expect(seen.map((call) => call.auth)).not.toContain(`Bearer ${XAI_KEY}`);
  }, 20_000);
});
