// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fail-open matrix for the decision client, through an injected fetch: no
// test here reaches the network.
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { decideEndpoint, isLoopbackUrl } from "./flux.ts";
import { createDecider } from "./index.ts";
import { DECIDER_LOG_DIR, flushDeciderLog } from "./log.ts";
import { readDecisionModelSettings, type DecisionModelSettings } from "./settings.ts";

const KEY = "sk-flux-unit_secret_key_0123456789abcdef"; // secret-scan: fixture
const ON = readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true } });
const OPTIONS = { maya: "Maya, Product Designer bot.", theo: "Theo, Frontend Engineer bot." };
const QUESTION = { instructions: "Which bot should answer `new_message`?", options: OPTIONS };
const STATE = { new_message: { from: "Milind", text: "PRIVATE-MESSAGE-TEXT the navbar overlaps on Safari" } };
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const choiceBody = (choice: string, probabilities: Record<string, number>) => ({
  model: "flux-decide-1", answers: { answer: { type: "choice", choice, probabilities } }, usage: { input_tokens: 612 },
});

function decider(settings: DecisionModelSettings, fetchImpl: FetchMock, opts: { key?: string | null; dataDir?: string } = {}) {
  return createDecider({
    settings: () => settings,
    credential: () => (opts.key === undefined ? KEY : opts.key),
    fetch: fetchImpl as unknown as typeof fetch,
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("gates: never a call, never a throw", () => {
  it.each([
    ["the master switch is off", readDecisionModelSettings({ enabled: false, jobs: { roomRouting: true } }), KEY, "disabled"],
    ["never set up", readDecisionModelSettings(undefined), KEY, "disabled"],
    ["the job is off", readDecisionModelSettings({ enabled: true, jobs: { roomRouting: false } }), KEY, "job_off"],
    ["no Flux key", ON, null, "no_key"],
    ["a remote base URL with no own key never gets the Flux key", readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true }, baseUrl: "https://elsewhere.example.com" }), KEY, "no_key"],
  ] as Array<[string, DecisionModelSettings, string | null, string]>)("%s -> %s", async (_n, settings, key, reason) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await decider(settings, fetchImpl, { key }).choose("roomRouting", STATE, QUESTION)).toEqual({ ok: false, reason });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a settings reader or credential that throws still comes back ok:false", async () => {
    const d1 = createDecider({ settings: () => { throw new Error("boom"); }, fetch: vi.fn() as unknown as typeof fetch });
    await expect(d1.choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false });
    const d2 = createDecider({ settings: () => ON, credential: () => { throw new Error("boom"); }, fetch: vi.fn() as unknown as typeof fetch });
    await expect(d2.choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false, reason: "no_key" });
  });
});

describe("the request on the wire", () => {
  it("POSTs {model:flux-decide,state,questions} to <base>/decide with the Bearer key and no redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(choiceBody("theo", { theo: 0.97, maya: 0.03 })));
    const result = await decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: true, provider: "flux", inputTokens: 612, model: "flux-decide-1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.fluxrouter.ai/v1/decide");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "flux-decide", state: STATE,
      questions: { answer: { type: "choice", instructions: QUESTION.instructions, criteria: OPTIONS } },
    });
  });

  it("a byoKey and https baseUrl override both", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(choiceBody("maya", { maya: 0.9, theo: 0.1 })));
    const settings = readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true }, byoKey: "own-key", baseUrl: "https://decide.example.com/v1/" });
    await decider(settings, fetchImpl).choose("roomRouting", STATE, QUESTION);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://decide.example.com/v1/decide");
    expect(init?.headers).toMatchObject({ authorization: "Bearer own-key" });
  });

  it("https anywhere, plain http only to this machine; questions outside limits never go out", async () => {
    expect(String(decideEndpoint("http://127.0.0.1:9911"))).toBe("http://127.0.0.1:9911/decide");
    expect(decideEndpoint("http://example.com")).toBeNull();
    expect(decideEndpoint("https://user:pw@example.com")).toBeNull();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(decider(readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true }, baseUrl: "http://example.com", byoKey: "k" }), fetchImpl).choose("roomRouting", STATE, QUESTION))
      .resolves.toMatchObject({ ok: false, reason: "misconfigured" });
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, { instructions: "?", options: { only: "one" } }))
      .resolves.toMatchObject({ ok: false, reason: "misconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("loopback is strict", () => {
  it("accepts real loopback hosts and rejects DNS names that start with 127.", () => {
    for (const u of ["http://127.0.0.1:9911", "http://127.1.2.3/v1", "http://localhost:80", "http://[::1]:8080/v1"]) {
      expect(decideEndpoint(u), u).not.toBeNull();
      expect(isLoopbackUrl(u), u).toBe(true);
    }
    for (const u of ["http://127.attacker.example/v1", "http://127.0.0.1.evil.com/v1", "http://127.0.0.256/v1", "http://128.0.0.1/v1"]) {
      expect(decideEndpoint(u), u).toBeNull();
      expect(isLoopbackUrl(u), u).toBe(false);
    }
  });

  it("the implicit Flux key goes to loopback only, never to a 127.* DNS name or a remote custom base", async () => {
    const send = async (baseUrl: string, key?: string) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(choiceBody("maya", { maya: 0.9, theo: 0.1 })));
      const settings = readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true }, baseUrl, ...(key ? { byoKey: key } : {}) });
      const result = await decider(settings, fetchImpl).choose("roomRouting", STATE, QUESTION);
      return { result, fetchImpl };
    };
    const evil = await send("http://127.attacker.example/v1");
    expect(evil.fetchImpl).not.toHaveBeenCalled();
    const remote = await send("https://decide.example.com/v1");
    expect(remote.fetchImpl).not.toHaveBeenCalled();
    const own = await send("https://decide.example.com/v1", "own-key");
    expect(own.fetchImpl.mock.calls[0]![1]?.headers).toMatchObject({ authorization: "Bearer own-key" });
    const local = await send("http://127.1.2.3:9911");
    expect(local.fetchImpl.mock.calls[0]![1]?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
  });
});

describe("failure matrix: every one is { ok:false }, none throws", () => {
  it.each([
    [401, "rejected"], [403, "disabled"], [404, "disabled"], [422, "http_error"], [429, "rate_limited"], [500, "http_error"], [503, "overloaded"], [529, "overloaded"],
  ])("HTTP %i -> %s, and the error body (which echoes the key) never surfaces", async (status, reason) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`bad key ${KEY}`, { status }));
    const result = await decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: false, reason, status });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it.each([
    ["a choice never offered", choiceBody("quinn", { quinn: 1 })],
    ["a choice that is not the argmax", choiceBody("maya", { maya: 0.2, theo: 0.8 })],
    ["no answers", { model: "x" }],
  ])("malformed body: %s", async (_n, body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false, reason: "malformed" });
  });

  it("a non-JSON body -> malformed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false, reason: "malformed" });
  });

  it("a network failure -> unreachable, without the key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed for ${KEY}`));
    const result = await decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("a slow answer -> timeout within the budget, and the request is aborted", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_u, init) => new Promise((_r, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const started = Date.now();
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION, { timeoutMs: 80 })).resolves.toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("a body that stalls after its headers still ends at the budget", async () => {
    const stalled = { ok: true, status: 200, json: () => new Promise(() => undefined), body: null } as unknown as Response;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stalled);
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION, { timeoutMs: 80 })).resolves.toMatchObject({ ok: false, reason: "timeout" });
  });

  it("the caller's own Stop -> cancelled", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>((_u, init) => new Promise((_r, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION, { signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });

  it("a fetch that throws synchronously never escapes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => { throw new Error("sync boom"); });
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false });
  });
});

describe("the decision log", () => {
  it("writes one 0600 row per call with no message text, descriptions or key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "murage-decider-log-"));
    const logs: string[] = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(choiceBody("theo", { theo: 0.94, maya: 0.06 })))
      .mockResolvedValueOnce(new Response(`echo ${KEY}`, { status: 529 }));
    const d = decider(ON, fetchImpl, { dataDir });
    await d.choose("roomRouting", STATE, QUESTION);
    await d.choose("roomRouting", STATE, QUESTION);
    // a gated call is not a decision and is not logged
    await decider(readDecisionModelSettings(undefined), fetchImpl, { dataDir }).choose("roomRouting", STATE, QUESTION);
    await flushDeciderLog(dataDir);

    const dir = join(dataDir, DECIDER_LOG_DIR);
    const [file] = readdirSync(dir);
    expect(file).toMatch(/^\d{4}-\d{2}\.ndjson$/);
    if (process.platform !== "win32") expect(statSync(join(dir, file!)).mode & 0o777).toBe(0o600);
    const text = readFileSync(join(dir, file!), "utf8");
    const rows = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ seam: "roomRouting", provider: "flux", ok: true, choice: "theo", pTop: 0.94, inputTokens: 612 });
    expect(rows[0].stateHash).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof rows[0].latencyMs).toBe("number");
    expect(rows[1]).toMatchObject({ ok: false, reason: "overloaded", status: 529, pTop: null });
    expect(text).not.toContain("PRIVATE-MESSAGE-TEXT");
    expect(text).not.toContain("Product Designer");
    expect(text).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
  });
});

describe("settings", () => {
  it("everything defaults off and an unknown provider reads as off", () => {
    expect(readDecisionModelSettings(undefined)).toEqual({ enabled: false, provider: "flux", jobs: { roomRouting: false } });
    expect(readDecisionModelSettings({ enabled: true, provider: "other" }).enabled).toBe(false);
    expect(readDecisionModelSettings({ enabled: "yes" as unknown as boolean }).enabled).toBe(false);
  });
});
