import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fixtures from "./opencode-tool-limit.fixtures.json" with { type: "json" };
import { readToolLimit, ToolLimitStore, routeKey, reduceCatalog, nativeCount, nativeExtras, applyCatalogRestrictions, openCodeToolId, type ToolMount } from "./opencode-tool-budget.ts";

const base = { permission: { "*": "ask", read: { "*": "allow" } }, agent: Object.fromEntries(["build", "plan", "general", "explore"].map(n => [n, { permission: { "*": "ask", read: { "*": "allow" } } }])) };
const mounts: ToolMount[] = [
  { name: "chief.a", role: "agents", tools: ["murage_help", "ask_user"], resources: false, required: ["murage_help", "ask_user"] },
  { name: "memory", role: "memory", tools: ["read", "write"], resources: false },
  { name: "apps", role: "connected", tools: ["a", "b", "c"], resources: false },
];
describe("C11 tool budget", () => {
  for (const row of fixtures) it(`c11-grammar: ${row.message}`, () => {
    expect(readToolLimit({ acpMethod: "session/prompt", message: row.message, data: { errorName: "APIError" } })).toBe(row.limit);
    expect(readToolLimit({ acpMethod: "session/load", message: row.message })).toBeUndefined();
    expect(readToolLimit({ acpMethod: "session/prompt", message: row.message, data: { errorName: "ContextOverflowError" } })).toBeUndefined();
  });
  it("c11-grammar parses message envelopes but never arbitrary numeric fields", () => {
    expect(readToolLimit({ acpMethod: "session/prompt", message: "Internal error", data: { errorName: "APIError", message: JSON.stringify({ error: { message: "at most 40 tools" } }) } })).toBe(40);
    expect(readToolLimit({ acpMethod: "session/prompt", data: { limit: 40, tools: 80 } })).toBeUndefined();
  });
  it("c11-route-isolation hashes ordered route inputs and requires a version", () => {
    const input = { executable: "/fixture/bin", version: "1.19.5", model: "opencode/mock", env: { HOME: "/fixture/home", OPENCODE_API_KEY: "fixture-secret" }, auth: Buffer.from("fixture-auth") };
    const key = routeKey(input)!;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(routeKey({ ...input, env: { OPENCODE_API_KEY: "fixture-secret", HOME: "/fixture/home" } })).toBe(key);
    for (const change of [{ version: "1.19.6" }, { model: "other/mock" }, { env: { HOME: "/other" } }, { auth: Buffer.from("changed") }]) expect(routeKey({ ...input, ...change })).not.toBe(key);
    expect(routeKey({ ...input, version: "" })).toBeUndefined();
  });
  it("c11-native counts pinned model/provider and resource groups", () => {
    expect(nativeCount("opencode/mock", mounts)).toBe(11);
    expect(nativeCount("opencode/gpt-5-mock", mounts)).toBe(10);
    expect(nativeCount("fixture/mock", mounts)).toBe(10);
    expect(nativeCount("fixture/gpt-5-mock", mounts)).toBe(9);
    expect(nativeCount("fixture/gpt-4", mounts)).toBe(10);
    expect(nativeCount("fixture/mock", [...mounts, { name: "unknown", role: "custom", resources: "unknown" }])).toBe(13);
  });
  it("c11-required-controls and deterministic immutable allocation", () => {
    const before = JSON.stringify(mounts);
    const result = reduceCatalog(mounts, 5, base);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.kept).toEqual(["chief_a_murage_help", "chief_a_ask_user", "memory_read", "memory_write", "apps_a"]);
    expect(result.restrictions).toEqual([["apps_*", "deny"], ["apps_a", "ask"]]);
    expect(JSON.stringify(mounts)).toBe(before);
    expect(reduceCatalog(mounts, 1, base).kind).toBe("noRoom");
    expect(openCodeToolId("beta-x.y", "t.1")).toBe("beta-x_y_t_1");
  });
  it("c11-proposal requires the actual singleton, even at zero budget", () => {
    const proposal: ToolMount = { name: "proposal.x", role: "agents", required: ["project_propose"], tools: ["project_propose"], resources: false };
    expect(reduceCatalog([proposal], 0, base).kind).toBe("noRoom");
    expect(reduceCatalog([proposal], 1, base)).toMatchObject({ kind: "ok", kept: ["proposal_x_project_propose"] });
    expect(reduceCatalog([{ ...proposal, tools: [] }], 1, base).kind).toBe("catalogUnknown");
  });
  it("c11-unknown-catalog never converts missing names into zero", () => {
    expect(reduceCatalog([{ ...mounts[0]!, tools: undefined }], 20, base).kind).toBe("catalogUnknown");
    expect(reduceCatalog([...mounts, { name: "other", role: "custom", resources: "unknown" }], 20, base)).toMatchObject({ kind: "ok", restrictions: [["other_*", "deny"]], unknown: ["other"] });
    expect(reduceCatalog([{ name: "empty", role: "custom", tools: [], resources: false }], 0, base)).toMatchObject({ kind: "ok", kept: [], unknown: [] });
  });
  it("c11-permission-safety protects natives and preserves all five copies", () => {
    for (const key of ["read", "codesearch", "code*", "*", "bash", "plan_*", "list_mcp_resources", "list_mcp_resource*", "read_mcp_resource"]) expect(() => applyCatalogRestrictions(base, [[key, "deny"]])).toThrow();
    const overlay = applyCatalogRestrictions(base, [["apps_*", "deny"], ["apps_a", "ask"]]);
    expect(overlay.permission).toMatchObject({ "*": "ask", "apps_*": "deny", apps_a: "ask", read: { "*": "allow" } });
    for (const agent of Object.values(overlay.agent as Record<string, { permission: unknown }>)) expect(agent.permission).toEqual(overlay.permission);
    expect(base.permission).not.toHaveProperty("apps_*");
    expect(reduceCatalog([{ ...mounts[0]!, name: "a" }, { name: "a", role: "custom", resources: false, tools: ["x"] }], 2, base).kind).toBe("noRoom");
  });
  it("c11-overlay-cap drops optional mounts to fit, never required controls", () => {
    const huge = Array.from({ length: 300 }, (_, i) => `${i}_` + "x".repeat(110));
    const result = reduceCatalog([...mounts, { name: "long", role: "custom", tools: huge, resources: false }], 200, base);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") { expect(Buffer.byteLength(JSON.stringify(result.overlay))).toBeLessThanOrEqual(48 * 1024); expect(result.kept).toContain("chief_a_ask_user"); expect(result.restrictions).toContainEqual(["long_*", "deny"]); }
    expect(reduceCatalog(mounts, 10, { ...base, padding: "x".repeat(49 * 1024) }).kind).toBe("noRoom");
  });
  it("c11-restart and c11-concurrent persist minimum limits and margin across instances", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "c11-store-")), "native", "limits.json");
    const key = "a".repeat(64), a = new ToolLimitStore(file), b = new ToolLimitStore(file);
    await Promise.all([a.learn(key, 48, "mock"), b.learn(key, 40, "mock")]);
    await Promise.all([a.increaseMargin(key), b.increaseMargin(key)]);
    expect(await new ToolLimitStore(file).get(key)).toMatchObject({ limit: 40, margin: 20 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = readFileSync(file, "utf8"); expect(saved).not.toContain("fixture-secret");
    const parsed = JSON.parse(saved); parsed.routes[key].learnedAt = Date.now() - 8 * 86400000; writeFileSync(file, JSON.stringify(parsed));
    expect(await new ToolLimitStore(file).get(key)).toBeUndefined();
  });
  it("c11-store bounds routes, ignores malformed rows and never extends TTL on reads", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "c11-store-")), "limits.json");
    let now = 1000; const store = new ToolLimitStore(file, { now: () => now });
    for (let i = 0; i < 65; i++) { now++; await store.learn(i.toString(16).padStart(64, "0"), 40, "mock"); }
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).routes)).toHaveLength(64);
    expect(await store.get("0".repeat(64))).toBeUndefined();
    const key = "1".padStart(64, "0"); const before = await store.get(key); now += 100; expect((await store.get(key))?.learnedAt).toBe(before?.learnedAt);
    writeFileSync(file, '{"v":1,"routes":{"bad":{"limit":5}}}'); expect(await store.get("bad")).toBeUndefined();
  });
  it("c11-crash-store rejects failed durable writes and serial queue survives", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "c11-store-")), "native", "limits.json");
    const failure = new Error("fixture EIO");
    const store = new ToolLimitStore(file, { write: () => { throw failure; } });
    await expect(store.learn("a".repeat(64), 40, "mock")).rejects.toBe(failure);
    expect(await store.get("a".repeat(64))).toBeUndefined();
    await new ToolLimitStore(file).learn("a".repeat(64), 40, "mock");
    await expect(store.increaseMargin("a".repeat(64))).rejects.toBe(failure);
    expect(await new ToolLimitStore(file).get("a".repeat(64))).toMatchObject({ limit: 40, margin: 4 });
  });
  it("c11-crash-store synchronizes new directory entries before the atomic write", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "c11-store-")), "native", "limits.json");
    const events: string[] = [];
    const store = new ToolLimitStore(file, {
      syncParent: path => { events.push(`directory:${path}`); },
      write: (path, text, options) => {
        expect(path).toBe(file); expect(options).toEqual({ mode: 0o600, syncDir: true });
        expect(JSON.parse(String(text)).routes["b".repeat(64)].limit).toBe(40);
        events.push("atomic");
      },
    });
    await store.learn("b".repeat(64), 40, "mock"); events.push("acknowledged");
    expect(events).toEqual([`directory:${join(file, "..")}`, "atomic", "acknowledged"]);
  });
  it("c11-review-1 retries a failed directory sync across store instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "c11-sync-retry-"));
    const file = join(root, "native", "nested", "limits.json");
    const events: string[] = [];
    let failed = false;
    const io = {
      syncParent: (path: string) => {
        events.push(path);
        if (!failed) { failed = true; throw new Error("once EIO"); }
      },
      write: () => { events.push("write"); },
    };
    await expect(new ToolLimitStore(file, io).learn("a".repeat(64), 40, "mock")).rejects.toThrow("once EIO");
    await new ToolLimitStore(file, io).learn("a".repeat(64), 40, "mock");
    expect(events).toEqual([join(root, "native"), join(root, "native"), join(root, "native", "nested"), "write"]);
  });
  it("c11-crash-store propagates creation sync EIO before any write", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "c11-store-")), "native", "limits.json");
    let wrote = false;
    const store = new ToolLimitStore(file, { syncParent: () => { throw new Error("creation EIO"); }, write: () => { wrote = true; } });
    await expect(store.learn("b".repeat(64), 40, "mock")).rejects.toThrow("creation EIO");
    expect(wrote).toBe(false);
  });
  it("c11-margin caps at 64 without resetting learnedAt", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "c11-store-")), "limits.json");
    const store = new ToolLimitStore(file), key = "c".repeat(64);
    const first = await store.learn(key, 40, "mock");
    for (let i = 0; i < 10; i++) await store.increaseMargin(key);
    expect(await store.get(key)).toMatchObject({ limit: 40, margin: 64, learnedAt: first.learnedAt });
  });

});


it("counts known ACP experimental flags without CLI-only plan tools", () => {
  expect(nativeCount("fixture/mock", [], nativeExtras({ OPENCODE_ENABLE_QUESTION_TOOL: "true", OPENCODE_EXPERIMENTAL_LSP_TOOL: "1", OPENCODE_EXPERIMENTAL_PLAN_MODE: "true" }))).toBe(12);
  expect(nativeCount("fixture/mock", [], nativeExtras({ OPENCODE_EXPERIMENTAL: "true", OPENCODE_EXPERIMENTAL_CODE_MODE: "false" }))).toBe(12);
});

it.each(["none", "file-sync", "rename", "creation-sync", "rename-sync", "unsupported-sync"])("c11-crash-store actual atomic syscall ordering: %s", async fault => {
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "c11-atomic-fault-"));
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const events=[], fault=${JSON.stringify(fault)}, file=${JSON.stringify(join(root, "native", "limits.json"))};
    const sync=fs.fsyncSync, rename=fs.renameSync; let renamed=false;
    const fail=code=>{throw Object.assign(new Error('fixture '+code),{code});};
    fs.fsyncSync=fd=>{const dir=fs.fstatSync(fd).isDirectory();const stage=dir?(renamed?'rename-sync':'creation-sync'):'file-sync';events.push(stage);if(fault===stage)fail('EIO');if(dir&&fault==='unsupported-sync')fail('EINVAL');return sync(fd);};
    fs.renameSync=(a,b)=>{events.push('rename');if(fault==='rename')fail('EIO');rename(a,b);renamed=true;};
    syncBuiltinESMExports();
    const {ToolLimitStore}=await import(${JSON.stringify(pathToFileURL(resolve("server/drivers/acp/opencode-tool-budget.ts")).href)});
    let acknowledged=false;try{await new ToolLimitStore(file).learn('d'.repeat(64),40,'mock');acknowledged=true;events.push('acknowledged');}catch(error){events.push(error.code);}
    let survived;try{survived=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
    process.stdout.write(JSON.stringify({events,acknowledged,survived}));
  `], { encoding: "utf8" });
  const result = JSON.parse(output);
  if (fault === "none" || fault === "unsupported-sync") {
    expect(result.events).toEqual(["creation-sync", "file-sync", "rename", "rename-sync", "acknowledged"]);
    expect(result.acknowledged).toBe(true);
  } else {
    expect(result.acknowledged).toBe(false);
    expect(result.events.at(-1)).toBe("EIO");
    expect(result.events).not.toContain("acknowledged");
  }
  if (fault === "rename-sync" || result.acknowledged) expect(result.survived.routes["d".repeat(64)]).toMatchObject({ limit: 40, margin: 4 });
  else expect(result.survived).toBeUndefined();
});

it.each([
  "at most 40 tools",
  { details: "at most 40 tools" },
  { error: { message: "at most 40 tools" } },
  JSON.stringify({ errorName: "APIError", message: "at most 40 tools" }),
])("c11-grammar preserves the existing provider envelope %j", data => {
  expect(readToolLimit({ acpMethod: "session/prompt", message: "Internal error", data })).toBe(40);
});
it("c11-grammar rejects excluded kinds inside nested named envelopes", () => {
  expect(readToolLimit({ acpMethod: "session/prompt", data: { message: JSON.stringify({ errorName: "ProviderAuthError", message: "at most 40 tools" }) } })).toBeUndefined();
});

it.each([
  "at most 40 tools, received 64, found 80",
  "at most 40 tools, got 64, received 64",
  "tools: array too long. Expected an array with maximum length 40, but got 64. found 80",
])("c11-review-5 rejects multiple actual counts: %s", message => {
  expect(readToolLimit({ acpMethod: "session/prompt", message })).toBeUndefined();
});
