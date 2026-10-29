// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// GROK-SETMODEL-1010: a Grok turn pins a model its session actually offers. A model the install does not offer yet
// runs on the closest one it does, with one plain line; only a session that offers nothing fails, with a next step.
// The bot's scoped GROK_HOME starts with a copy of the owner's model list cache, so the first turn after a switch
// to Grok already sees the fetched catalog. Synthetic homes and the fake ACP CLI only.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { SendTurnInput } from "../../contracts.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { resetIsolationCache } from "../isolation-cache.ts";
import { modelLabel, pickAdvertisedModel, resolveAcpModelId } from "./acp-model-id.ts";
import { resolveCursorAcpModelId } from "./cursor.ts";
import { GROK_MODELS_CACHE, grokModelsCacheCopy, scopeGrokHome } from "./grok-scope.ts";
import { configureGrokSession, GrokAgentDriver } from "./grok.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) removeTempDirSync(home); });

const SUBSTITUTED = "Running Grok 4.6 for this turn: Grok 4.7 is not offered by your Grok install yet.";

/** A fake ACP session: records every request, refuses set_model when `refuse` is set. */
function fakeSession(opts: { models?: string[]; current?: string; refuse?: boolean; providerRoute?: boolean; model?: string } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const notices: string[] = [];
  const ctx = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (opts.refuse) throw Object.assign(new Error("Invalid params"), { code: -32602 });
      return {};
    },
    sessionId: "s1",
    config: {} as any,
    turn: { threadId: "t", text: "hi", model: opts.model ?? "grok-4.7", ...(opts.providerRoute ? { providerRoute: {} as any } : {}) } as SendTurnInput,
    sessionModels: (opts.models ?? []).map((modelId) => ({ modelId })),
    ...(opts.current ? { currentModelId: opts.current } : {}),
    notice: (line: string) => { notices.push(line); },
  };
  return { ctx, calls, notices, run: () => configureGrokSession(ctx) };
}

describe("Grok session model pick (configureGrokSession)", () => {
  it("pins the wanted model when the session offers it, with no line", async () => {
    const s = fakeSession({ models: ["grok-4.7", "grok-4.6"], current: "grok-4.6" });
    expect(await s.run()).toEqual({ model: "grok-4.7" });
    expect(s.calls).toEqual([{ method: "session/set_model", params: { sessionId: "s1", modelId: "grok-4.7" } }]);
    expect(s.notices).toEqual([]);
  });

  it("pins the advertised id a cursor-style match finds (parameterised id)", async () => {
    const s = fakeSession({ models: ["grok-4.7[effort=high]", "grok-4.6"], current: "grok-4.6" });
    expect(await s.run()).toEqual({ model: "grok-4.7[effort=high]" });
    expect(s.calls[0]!.params.modelId).toBe("grok-4.7[effort=high]");
    expect(s.notices).toEqual([]);
  });

  it("runs the closest advertised model of the same family, newest first, and says so in one plain line", async () => {
    const s = fakeSession({ models: ["grok-4.5", "grok-code-fast-1", "grok-4.6"], current: "grok-4.5" });
    expect(await s.run()).toEqual({ model: "grok-4.6" });
    expect(s.calls).toEqual([{ method: "session/set_model", params: { sessionId: "s1", modelId: "grok-4.6" } }]);
    expect(s.notices).toEqual([SUBSTITUTED]);
    expect(s.notices[0]).not.toMatch(/[—–]/);
  });

  it("falls back to the session's current model when no family member is offered, without a set_model", async () => {
    const s = fakeSession({ models: ["grok-4.6", "other-model"], current: "grok-4.6", model: "my-local" });
    expect(await s.run()).toEqual({ model: "grok-4.6" });
    expect(s.calls).toEqual([]);
    expect(s.notices).toEqual(["Running Grok 4.6 for this turn: My Local is not offered by your Grok install yet."]);
  });

  it("skips set_model when the wanted model is already current", async () => {
    const s = fakeSession({ models: ["grok-4.7", "grok-4.6"], current: "grok-4.7" });
    expect(await s.run()).toEqual({ model: "grok-4.7" });
    expect(s.calls).toEqual([]);
    expect(s.notices).toEqual([]);
  });

  it("a session that offers nothing gets the slug as before, and a refusal fails the turn with a next step", async () => {
    const ok = fakeSession({});
    await ok.run();
    expect(ok.calls[0]!.params.modelId).toBe("grok-4.7");
    const refused = fakeSession({ refuse: true });
    const error = await refused.run().then(() => null, (e: Error) => e);
    expect(error?.message).toBe("Grok could not switch this conversation to Grok 4.7. Update Grok to its latest version, then send the message again, or choose another Grok model in this bot's settings.");
    expect(error?.message).not.toMatch(/[—–]/);
  });

  it("a provider-routed turn pins its own slug exactly and is never swapped for an offered model", async () => {
    const s = fakeSession({ models: ["grok-4.6"], current: "grok-4.6", providerRoute: true, model: "murage_route1" });
    await s.run();
    expect(s.calls[0]!.params.modelId).toBe("murage_route1");
    expect(s.notices).toEqual([]);
  });

  it("no model on the turn: nothing is sent", async () => {
    const s = fakeSession({ models: ["grok-4.6"] });
    (s.ctx.turn as any).model = undefined;
    expect(await s.run()).toBeUndefined();
    expect(s.calls).toEqual([]);
  });
});

describe("shared ACP model matching", () => {
  it("Cursor keeps the same matcher", () => {
    expect(resolveCursorAcpModelId).toBe(resolveAcpModelId);
    expect(resolveAcpModelId([{ modelId: "default[]", name: "Auto" }], "auto")).toBe("default[]");
  });
  it("prefers the same variant within a family, then the newest version", () => {
    const models = ["grok-4.6", "grok-4.6-fast", "grok-4.5-fast", "grok-4.10"].map((modelId) => ({ modelId }));
    expect(pickAdvertisedModel(models, "grok-4.7-fast", "grok-4.6")).toEqual({ kind: "substitute", modelId: "grok-4.6-fast" });
    expect(pickAdvertisedModel(models, "grok-4.7", "grok-4.6")).toEqual({ kind: "substitute", modelId: "grok-4.10" });
    expect(pickAdvertisedModel([], "grok-4.7", undefined)).toEqual({ kind: "none" });
    expect(pickAdvertisedModel([], "grok-4.7", "grok-4.6")).toEqual({ kind: "substitute", modelId: "grok-4.6" });
    expect(modelLabel("grok-4.6-fast[effort=high]")).toBe("Grok 4.6 Fast");
  });
});

function ownerHome(cache?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "murage-grok-setmodel-"));
  homes.push(home);
  const grok = join(home, ".grok");
  mkdirSync(grok, { recursive: true });
  writeFileSync(join(grok, "config.toml"), '[models]\ndefault = "grok-4.7"\n');
  writeFileSync(join(grok, "auth.json"), "{}");
  if (cache !== undefined) writeFileSync(join(grok, GROK_MODELS_CACHE), JSON.stringify(cache));
  return home;
}

describe("scoped GROK_HOME model list cache seed", () => {
  it("copies (never links) the owner's cache into the scope, refreshes it, and drops it with the owner's", () => {
    ensureDirs();
    resetIsolationCache();
    const home = ownerHome({ models: [{ id: "grok-4.7" }] });
    const owner = join(home, ".grok", GROK_MODELS_CACHE);
    const env: Record<string, string | undefined> = { HOME: home };
    scopeGrokHome(env, "grok 1.0.50", "bot-seed");
    const scoped = join(env.GROK_HOME!, GROK_MODELS_CACHE);
    expect(lstatSync(scoped).isFile()).toBe(true);
    expect(lstatSync(scoped).isSymbolicLink()).toBe(false);
    expect(readFileSync(scoped, "utf8")).toBe(readFileSync(owner, "utf8"));
    // a write in the scope never reaches the owner's file
    writeFileSync(scoped, JSON.stringify({ models: [] }));
    expect(JSON.parse(readFileSync(owner, "utf8"))).toEqual({ models: [{ id: "grok-4.7" }] });
    // refreshed from the owner's on the next build
    writeFileSync(owner, JSON.stringify({ models: [{ id: "grok-4.8" }] }));
    resetIsolationCache();
    const again: Record<string, string | undefined> = { HOME: home };
    scopeGrokHome(again, "grok 1.0.50", "bot-seed");
    expect(again.GROK_HOME).toBe(env.GROK_HOME);
    expect(JSON.parse(readFileSync(scoped, "utf8"))).toEqual({ models: [{ id: "grok-4.8" }] });
    // the owner's removed: the copy goes too
    rmSync(owner);
    resetIsolationCache();
    scopeGrokHome({ HOME: home }, "grok 1.0.50", "bot-seed");
    expect(existsSync(scoped)).toBe(false);
  });

  it("never follows a link, and skips a cache that is not JSON", () => {
    const home = ownerHome();
    const grok = join(home, ".grok");
    const secret = join(home, "elsewhere.json");
    writeFileSync(secret, JSON.stringify({ secret: true }));
    let linked = true;
    try { symlinkSync(secret, join(grok, GROK_MODELS_CACHE)); } catch { linked = false; } // Windows without symlink rights
    if (linked) {
      expect(grokModelsCacheCopy(grok)).toEqual({});
      rmSync(join(grok, GROK_MODELS_CACHE));
    }
    writeFileSync(join(grok, GROK_MODELS_CACHE), "not json");
    expect(grokModelsCacheCopy(grok)).toEqual({});
    expect(grokModelsCacheCopy(join(home, "missing"))).toEqual({});
  });
});

describe("first Grok turn in a fresh bot scope", () => {
  async function firstTurn(cache: unknown | undefined, threadId: string) {
    ensureDirs();
    resetIsolationCache();
    const home = ownerHome(cache);
    const dump = join(home, "spawn.json");
    const instance = await GrokAgentDriver.create({ instanceId: `grok-setmodel-${threadId}`, displayName: "Grok", enabled: true,
      config: GrokAgentDriver.decodeConfig({ cli, fullAuto: true }),
      environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_VERSION: "grok 1.0.50 (fixture)",
        FAKE_ACP_GROK_MODELS_CACHE: "1", FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" } });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId, text: "hello", cwd: home, model: "grok-4.7" } as SendTurnInput); // a fresh owner home: a fresh scope
      const completed = await recorder.until((e) => e.threadId === threadId && e.type === "turn.completed", 15000);
      const configCalls = existsSync(`${dump}.config.json`) ? JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{ method: string; params: any }> : [];
      const notices = recorder.events.filter((e: any) => e.threadId === threadId && e.type === "item.started" && e.toolKind === "notice").map((e: any) => e.title as string);
      const started = recorder.events.find((e: any) => e.threadId === threadId && e.type === "session.started") as any;
      return { completed, setModels: configCalls.filter((c) => c.method === "session/set_model").map((c) => c.params.modelId), notices, model: started?.model };
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  }

  it("with the owner's cache present, sets Grok 4.7 and posts no substitution line", async () => {
    const r = await firstTurn({ models: [{ id: "grok-4.7" }] }, "grok-setmodel-seeded");
    expect(r.completed).toMatchObject({ ok: true });
    expect(r.setModels).toEqual(["grok-4.7"]);
    expect(r.notices).not.toContain(SUBSTITUTED);
    expect(r.model).toBe("grok-4.7");
  });

  it("without a cache, runs Grok 4.6 with one plain line instead of failing", async () => {
    const r = await firstTurn(undefined, "grok-setmodel-unseeded");
    expect(r.completed).toMatchObject({ ok: true });
    expect(r.setModels).toEqual([]);
    expect(r.notices.filter((n) => n === SUBSTITUTED)).toHaveLength(1);
    expect(r.model).toBe("grok-4.6");
  });
});
