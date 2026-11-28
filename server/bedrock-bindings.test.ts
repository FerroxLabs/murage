// M9 witnesses: binding store (W4 generation fence, W5 await check, W13 restart, W24 write-through-cfg and the bounded busy wait).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BedrockBindings, BEDROCK_BUSY_TEXT, bedrockCfgDeps } from "./bedrock-bindings.ts";
import { persistableClaudeInstances, replaceClaudeAccountInstances } from "./claude-account-config.ts";
import { newClaudeAccount } from "./claude-accounts.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A store over a real cfg object and the real account config writer (the same one the account route uses). */
function harness(check: (i: { profile: string; region: string }) => Promise<string>, opts: { busy?: { v: boolean }; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bedrock-bind-")); dirs.push(dir);
  const path = join(dir, "config.json");
  const cfg: any = { instances: { "claude-1": { driver: "claudeAgent", displayName: "AWS", config: { configDir: join(dir, "providers", "claude-1"), bedrock: { profile: "p0", region: "us-east-1" } } } } };
  const busy = opts.busy ?? { v: false };
  const store = new BedrockBindings({
    ...bedrockCfgDeps(cfg, () => { replaceClaudeAccountInstances(persistableClaudeInstances(cfg), path); }),
    busy: { get: () => busy.v, set: (v) => { busy.v = v; } },
    check: async (i) => check(i),
    writeWaitMs: opts.waitMs, sleep: opts.sleep,
  });
  const disk = () => JSON.parse(readFileSync(path, "utf8")).instances["claude-1"].config.bedrock;
  return { store, cfg, path, disk, busy };
}
const defer = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe("binding store", () => {
  it("a missing accountId or a bad epoch is UNBOUND (W13 through the store)", () => {
    const h = harness(async () => "111111111111");
    expect(h.store.read("claude-1"), "W13 store partial").toBeNull(); // W13-store
    h.cfg.instances["claude-1"].config.bedrock = { profile: "p", region: "us-east-1", accountId: "111111111111", epoch: "x" };
    expect(h.store.read("claude-1")).toBeNull();
    h.cfg.instances["claude-1"].config.bedrock = { profile: "p", region: "us-east-1", accountId: "111111111111", epoch: 4 };
    expect(h.store.read("claude-1")?.epoch).toBe(4);
  });
  it("W4 a slow check of the old profile never binds over a newer Save", async () => {
    const slow = defer<string>();
    const h = harness((i) => (i.profile === "p1" ? slow.promise : Promise.resolve("222222222222")));
    const a = h.store.save("claude-1", { profile: "p1", region: "us-east-1" });
    const b = await h.store.save("claude-1", { profile: "p2", region: "us-east-1" });
    expect(b.ok).toBe(true);
    slow.resolve("111111111111");
    const aResult = await a;
    expect(aResult.ok, "W4 stale result discarded").toBe(false); // W4
    expect(h.disk().profile).toBe("p2");
    expect(h.disk().epoch).toBe(1);
    expect(h.disk().accountId).toBe("222222222222");
  });
  it("W5 a turn admitted during a re-bind waits and reads the new binding", async () => {
    const gate = defer<string>();
    const h = harness((i) => (i.profile === "p1" ? Promise.resolve("111111111111") : gate.promise));
    expect((await h.store.save("claude-1", { profile: "p1", region: "us-east-1" })).ok).toBe(true);
    const rebind = h.store.save("claude-1", { profile: "p2", region: "us-east-1" });
    let seen: string | undefined;
    const admitted = h.store.awaitCheck("claude-1").then(() => { seen = h.store.read("claude-1")?.profile; });
    await Promise.resolve();
    expect(seen, "W5 the turn is still waiting for the check").toBeUndefined(); // W5
    gate.resolve("222222222222");
    await rebind; await admitted;
    expect(seen, "W5 launches on the new profile").toBe("p2");
  });
  it("W24 re-bind then an account PATCH (through the same writer) then reload from disk: the binding is B", async () => {
    const h = harness(async (i) => (i.profile === "A" ? "111111111111" : "222222222222"));
    await h.store.save("claude-1", { profile: "A", region: "us-east-1" });
    await h.store.save("claude-1", { profile: "B", region: "us-east-1" });
    const next = persistableClaudeInstances(h.cfg); // the PATCH route's read of cfg
    next["claude-1"]!.displayName = "Renamed";
    replaceClaudeAccountInstances(next, h.path);
    expect(h.disk().profile, "W24 PATCH keeps B").toBe("B"); // W24-a
    expect(h.disk().epoch).toBe(2);
  });
  it("W24 second case: the write waits while providerConfigBusy is held, then lands; after both settle the persisted binding is B", async () => {
    const busy = { v: true }; let slept = 0;
    const h = harness(async () => "222222222222", { busy, waitMs: 5000, sleep: async () => { slept++; busy.v = false; } });
    const r = await h.store.save("claude-1", { profile: "B", region: "us-east-1" });
    expect(slept, "W24 waited for providerConfigBusy before writing").toBeGreaterThan(0); // W24-b
    expect(r.ok).toBe(true);
    expect(h.disk().profile).toBe("B");
    expect(busy.v, "the store held the flag for its write only").toBe(false);
  });
  it("W24 third case (M4): the wait is bounded; on expiry the previous state stays and Save says engine setup is finishing", async () => {
    const busy = { v: true };
    let slept = 0;
    const h = harness(async () => "222222222222", { busy, waitMs: 200, sleep: async (ms) => { slept += ms; } });
    h.cfg.instances["claude-1"].config.bedrock = { profile: "A", region: "us-east-1", accountId: "111111111111", epoch: 1 };
    const r = await h.store.save("claude-1", { profile: "B", region: "us-east-1" });
    expect(r.ok, "W24 the wait is bounded").toBe(false); // W24-c
    expect(r.ok === false && r.reason, "W24 deadline text").toBe(BEDROCK_BUSY_TEXT);
    expect(slept).toBeGreaterThanOrEqual(200);
    expect(h.store.read("claude-1")?.profile, "previous state stays").toBe("A");
  });
  it("W24 PATCH-in-flight (M6): a write that would land after a newer Save is dropped by the generation re-test", async () => {
    const busy = { v: true };
    const gate = defer<void>();
    const h = harness(async (i) => (i.profile === "A" ? "111111111111" : "222222222222"), { busy, waitMs: 5000, sleep: () => gate.promise });
    const first = h.store.save("claude-1", { profile: "A", region: "us-east-1" });
    await new Promise((r) => setTimeout(r, 15)); // A's check resolved: A sits in the busy wait, still the current generation
    const second = h.store.save("claude-1", { profile: "B", region: "us-east-1" });
    await new Promise((r) => setTimeout(r, 15)); // B's check resolved too
    busy.v = false; gate.resolve(); // the PATCH finished: both waiters wake together
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult.ok).toBe(true);
    expect(firstResult.ok, "W24 no write without re-testing the generation").toBe(false); // W24-d
    expect(h.store.read("claude-1")?.profile).toBe("B");
    expect(h.disk().epoch, "exactly one bind landed").toBe(1);
  });

  it("R3-B1 a new account (the create route's pending block) binds on its first Save and check, which sends no profile or region", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-new-")); dirs.push(dir);
    const path = join(dir, "config.json");
    // the real create path: POST /api/claude-accounts with the add form's body writes profile and region only
    const created = newClaudeAccount({}, { displayName: "AWS", bedrock: { profile: "personal", region: "us-east-1" } }, dir);
    const cfg: any = { instances: created.instances };
    const checked: Array<{ profile: string; region: string }> = [];
    const store = new BedrockBindings({
      ...bedrockCfgDeps(cfg, () => { replaceClaudeAccountInstances(persistableClaudeInstances(cfg), path); }),
      busy: { get: () => false, set: () => {} },
      check: async (i) => { checked.push({ profile: i.profile, region: i.region }); return "111111111111"; },
    });
    expect(store.read(created.instanceId), "the new account is not bound yet").toBeNull();
    // POST /api/claude-accounts/<id>/bedrock with {} (the route maps it to save(id) with no input)
    const saved = await store.save(created.instanceId);
    expect(saved, "R3-B1 the first bind of a new account reaches IDENTITY and binds").toMatchObject({ ok: true, binding: { profile: "personal", region: "us-east-1", accountId: "111111111111", epoch: 1 } }); // R3-B1
    expect(checked, "one STS check with the pending values").toEqual([{ profile: "personal", region: "us-east-1" }]);
    expect(JSON.parse(readFileSync(path, "utf8")).instances[created.instanceId].config.bedrock).toEqual({ profile: "personal", region: "us-east-1", accountId: "111111111111", epoch: 1 });
    // a pending block with a bad profile still refuses before STS
    cfg.instances[created.instanceId].config.bedrock = { profile: "bad profile!", region: "us-east-1" };
    expect((await store.save(created.instanceId)).ok, "a bad pending profile is refused").toBe(false);
    expect(checked.length, "no STS call for it").toBe(1);
  });
});
