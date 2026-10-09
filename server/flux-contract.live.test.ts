// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LIVE contract check against the real Flux Router. Skipped unless
// FLUX_CONTRACT_KEY is set (the daily workflow sets it from the repo secret of
// the same name); normal runs never touch the network. Cheap probes only: a
// models list, one-token completions, token counting, a tiny decision, a two
// letter clip of speech, a half-second tone to transcribe, one search result.
// Costly or side-effecting routes (images, lookups, connected apps) are probed
// for presence only: a bad request must come back 400/422/401 from a handler,
// never 404. Nothing here sends a message or changes an account.
// Murage's own parsers do the reading wherever there is one, so drift in what
// Flux returns fails here before a user sees it. The key is never printed.
import { describe, expect, it } from "vitest";

import { createDecider } from "./decider/index.ts";
import { readDecisionModelSettings } from "./decider/settings.ts";
import { synthesize } from "./tts/flux-speech.ts";
import { searchFlux } from "./web-search.ts";
import { transcribe, TranscriptionUnavailable } from "./voice/flux-voice.ts";
import { FLUX_ENDPOINTS } from "./flux-contract-endpoints.ts";

const KEY = process.env.FLUX_CONTRACT_KEY?.trim() ?? "";
const HOST = process.env.FLUX_CONTRACT_HOST?.trim() || "https://api.fluxrouter.ai";
const MODEL = "flux-fast";
const live = describe.skipIf(!KEY);

const url = (id: string) => `${HOST}${FLUX_ENDPOINTS.find((e) => e.id === id)!.path}`;
const auth = { authorization: `Bearer ${KEY}` };
const json = { "content-type": "application/json", ...auth };

async function call(id: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(url(id), { redirect: "error", signal: AbortSignal.timeout(45_000), ...init });
  const text = await response.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body };
}
/** A route that exists answers a bad request with a handler's 4xx, never 404/405/5xx. */
function served(status: number, label: string) {
  expect([400, 401, 403, 415, 422], `${label}: expected a handled refusal, got ${status}`).toContain(status);
}
// Registered by id, so flux-contract-endpoints.test.ts can see every endpoint has one.
const probe = (id: string, fn: () => Promise<void>) => it(id, fn, 60_000);

/** 0.4 s of a 440 Hz tone, 16 kHz mono 16-bit WAV (12.8 KB). */
function tone(): Uint8Array {
  const samples = 6_400;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / 16_000) * 8_000), true);
  return bytes;
}

live("live Flux contract", () => {
  probe("models", async () => {
    const { status, body } = await call("models", { headers: auth });
    expect(status).toBe(200);
    expect(Array.isArray(body?.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) expect(typeof row.id).toBe("string");
    const ids = body.data.map((row: { id: string }) => row.id);
    for (const wanted of ["flux-auto", "flux-fast"]) expect(ids, `models must list ${wanted}`).toContain(wanted);
  });

  probe("chat.completions", async () => {
    const { status, body } = await call("chat.completions", { method: "POST", headers: json, body: JSON.stringify({ model: MODEL, max_tokens: 4, stream: false, messages: [{ role: "user", content: "Say ok." }] }) });
    expect(status).toBe(200);
    expect(Array.isArray(body?.choices)).toBe(true);
    expect(["string", "object"]).toContain(typeof body.choices[0].message.content);
    expect(typeof body.usage?.total_tokens).toBe("number");
  });

  const anthropicHeaders = { ...auth, "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const messageProbe = async (id: string) => {
    const { status, body } = await call(id, { method: "POST", headers: anthropicHeaders, body: JSON.stringify({ model: MODEL, max_tokens: 4, messages: [{ role: "user", content: "Say ok." }] }) });
    expect(status).toBe(200);
    expect(body?.type).toBe("message");
    expect(Array.isArray(body.content)).toBe(true);
    expect(typeof body.usage?.input_tokens).toBe("number");
  };
  probe("messages", () => messageProbe("messages"));
  probe("messages.anthropic-base", () => messageProbe("messages.anthropic-base"));

  probe("messages.count_tokens", async () => {
    const { status, body } = await call("messages.count_tokens", { method: "POST", headers: anthropicHeaders, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "Say ok." }] }) });
    expect(status).toBe(200);
    expect(typeof body?.input_tokens).toBe("number");
  });

  probe("responses", async () => {
    const { status, body } = await call("responses", { method: "POST", headers: json, body: JSON.stringify({ model: MODEL, max_output_tokens: 16, input: "Say ok." }) });
    expect(status).toBe(200);
    expect(Array.isArray(body?.output)).toBe(true);
    expect(typeof body.status).toBe("string");
  });

  probe("decide", async () => {
    // Murage's own decider: request building, headers and answer parsing.
    const decider = createDecider({
      settings: () => readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true } }),
      credential: () => KEY,
      dataDir: process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp",
    });
    const result = await decider.choose("roomRouting", { new_message: { from: "owner", text: "Please fix the CSS on the navbar." }, bots_in_room: ["Maya", "Ravi"] }, {
      instructions: "Which bot should answer new_message?",
      options: { maya: "Maya, frontend designer. UI and CSS.", ravi: "Ravi, backend engineer. APIs and billing." },
    }, { timeoutMs: 5_000 });
    expect(result, `decide failed: ${JSON.stringify(result.ok ? {} : { reason: result.reason, status: result.status })}`).toMatchObject({ ok: true });
    if (result.ok) {
      expect(["maya", "ravi"]).toContain(result.answers.choice);
      expect(result.answers.pTop).toBeGreaterThan(0);
    }
  });

  probe("audio.voices", async () => {
    const { status, body } = await call("audio.voices", { headers: auth });
    expect(status).toBe(200);
    expect(body && typeof body === "object").toBe(true);
  });

  probe("audio.speech", async () => {
    const audio = await synthesize("ok", "marin", { via: "flux", label: "Flux Router", baseUrl: `${HOST}/v1`, key: KEY, model: "flux-voice-speak" });
    expect(audio.bytes.byteLength).toBeGreaterThan(500);
    expect(audio.mime).toMatch(/^audio\//);
  });

  probe("audio.transcriptions", async () => {
    try {
      const transcript = await transcribe({ bytes: tone(), filename: "tone.wav", mime: "audio/wav" }, { model: "flux-voice-fast", env: { FLUX_API_KEY: KEY } as NodeJS.ProcessEnv, endpoint: { via: "flux", baseUrl: `${HOST}/v1`, key: KEY, model: "flux-voice-fast" } });
      expect(typeof transcript.text).toBe("string");
    } catch (error) {
      // A tone with no words may be refused as unreadable audio: the route and the contract still work.
      expect(error).toBeInstanceOf(TranscriptionUnavailable);
      expect((error as TranscriptionUnavailable).reason, "transcription refused the key or the route").toBe("format");
    }
  });

  probe("search", async () => {
    const result = await searchFlux({ baseUrl: `${HOST}/v1`, apiKey: KEY, query: "What is the capital of France?", maxResults: 1 });
    expect(result.provider).toBe("flux");
    expect(result.answer?.length ?? 0).toBeGreaterThan(0);
    expect(result.results.length).toBeLessThanOrEqual(1);
  });

  // Presence probes: costly or side-effecting routes get an empty request.
  probe("voice.lookup", async () => {
    served((await call("voice.lookup", { method: "POST", headers: json, body: "{}" })).status, "voice.lookup");
  });
  probe("images.generations", async () => {
    served((await call("images.generations", { method: "POST", headers: json, body: "{}" })).status, "images.generations");
  });
  probe("images.edits", async () => {
    served((await call("images.edits", { method: "POST", headers: auth, body: new FormData() })).status, "images.edits");
  });

  probe("composio.health", async () => {
    const response = await fetch(url("composio.health"), { redirect: "error", signal: AbortSignal.timeout(20_000) });
    expect(response.status).toBe(200);
  });
  probe("composio.broker", async () => {
    // No broker token is minted here (it would count against the account's five). Without one the broker must refuse, not 404.
    const { status } = await call("composio.broker", { headers: { authorization: `Bearer ${"0".repeat(64)}` } });
    expect([401, 403], "broker route missing or not allowlisted").toContain(status);
  });
});
