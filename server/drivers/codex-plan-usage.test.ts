// Plan usage over the Codex app-server Murage already runs (GAP-PLAN-LIMITS rev 1.2, section 5.1,
// PL-02, PL-04, PL-05): against the scripted fake app-server. Reads go only to a live, retained
// process; account frames never reach the native tee or the turn; nothing is spawned for a meter.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { NATIVE_DIR } from "../config.ts";
import { planUsageService } from "../plan-usage.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CodexDriver } from "./codex.ts";
import { resetIsolationCache } from "./isolation-cache.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const ENV = ["FAKE_CODEX_WARM", "FAKE_CODEX_MODE", "FAKE_CODEX_CALL_LOG", "FAKE_CODEX_RATE_LIMITS", "FAKE_CODEX_RATE_LIMITS_EVENT", "FAKE_CODEX_VERSION"];

describe("Codex plan usage (fake app-server)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;
  let callLog: string;
  let seq = 0;
  let instanceId = "";

  const create = async () => {
    instanceId = `codex-plan-${process.pid}-${++seq}`;
    instance = await CodexDriver.create({
      instanceId, displayName: "Codex Plan Test", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };
  const run = async (threadId: string, extra: Partial<SendTurnInput> = {}) => {
    const sent = await instance!.adapter.sendTurn({ threadId, text: "hello", warmIdentity: { botId: "b1", audience: "owner" }, ...extra });
    return recorder!.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId) as Promise<any>;
  };
  const reads = () => readFileSync(callLog, "utf8").split("\n").filter((l) => l.endsWith(" account/rateLimits/read")).length;
  const subject = () => `codex:${instanceId}:b1`;
  const eventually = async (check: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(check()).toBe(true);
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    resetIsolationCache();
    scratch = mkdtempSync(join(tmpdir(), "murage-codex-plan-"));
    callLog = join(scratch, "calls.log");
    writeFileSync(callLog, "");
    process.env.FAKE_CODEX_CALL_LOG = callLog;
    process.env.FAKE_CODEX_WARM = "1";
    process.env.FAKE_CODEX_MODE = "resume";
    // appendNative writes only into an existing directory (ensureDirs makes it at boot)
    mkdirSync(NATIVE_DIR, { recursive: true });
  });
  afterEach(async () => {
    for (const key of ENV) delete process.env[key];
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  it("a notification during a turn and an owner read on the retained process both report; neither reaches the native tee", async () => {
    process.env.FAKE_CODEX_RATE_LIMITS_EVENT = JSON.stringify({ rateLimits: { limitId: "codex", primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1_900_000_000 } } });
    await create();
    const threadId = `t-plan-${Date.now()}`;
    const done = await run(threadId);
    expect(done.ok).toBe(true);
    expect(planUsageService.observation(subject())).toMatchObject({ status: "current", source: "native-event", windows: [expect.objectContaining({ usedPercent: 11, windowSeconds: 18_000, resetsAt: 1_900_000_000_000 })] });
    // the turn's own reply was untouched by the account frame
    expect(recorder!.events.some((e) => e.type === "runtime.error")).toBe(false);
    expect(reads()).toBe(0);

    planUsageService.demand([subject()], { owner: true });
    await eventually(() => planUsageService.observation(subject()).source === "native-rpc");
    expect(planUsageService.observation(subject()).windows.map((w) => [w.windowId, w.usedPercent])).toEqual([["primary", 42], ["secondary", 7]]);
    expect(reads()).toBe(1);

    const tee = join(NATIVE_DIR, `${threadId}.ndjson`);
    expect(existsSync(tee)).toBe(true);
    const logged = readFileSync(tee, "utf8");
    expect(logged).toContain("turn/completed");
    expect(logged).not.toMatch(/rateLimits|account\//);
  });

  it("a Codex without the method shows plan usage as not available and is not asked again on that process", async () => {
    process.env.FAKE_CODEX_RATE_LIMITS = "absent";
    await create();
    await run(`t-plan-absent-${Date.now()}`);
    planUsageService.demand([subject()], { owner: true });
    await eventually(() => planUsageService.observation(subject()).reason === "unsupported");
    expect(planUsageService.observation(subject())).toMatchObject({ status: "unavailable", windows: [] });
    await new Promise((r) => setTimeout(r, 100));
    planUsageService.demand([subject()], { owner: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(reads()).toBe(1);
  });

  it("a Codex older than the pinned minimum is never read", async () => {
    process.env.FAKE_CODEX_VERSION = "codex-cli 0.99.0";
    process.env.FAKE_CODEX_RATE_LIMITS_EVENT = JSON.stringify({ rateLimits: { primary: { usedPercent: 5 } } });
    await create();
    await run(`t-plan-old-${Date.now()}`);
    planUsageService.demand([subject()], { owner: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(reads()).toBe(0);
    expect(planUsageService.observation(subject())).toMatchObject({ status: "unavailable", reason: "awaiting-session", windows: [] });
  });

  it("when the process ends its readings go: the account shows plan usage as not available", async () => {
    process.env.FAKE_CODEX_RATE_LIMITS_EVENT = JSON.stringify({ rateLimits: { primary: { usedPercent: 33 } } });
    await create();
    await run(`t-plan-end-${Date.now()}`);
    expect(planUsageService.observation(subject()).windows).toHaveLength(1);
    await instance!.dispose();
    instance = undefined;
    await eventually(() => planUsageService.observation(subject()).reason === "awaiting-session");
    expect(planUsageService.observation(subject()).windows).toEqual([]);
  });
});
