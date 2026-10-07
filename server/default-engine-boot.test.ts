import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootEngineChoice, readRememberedEngine } from "./default-engine.ts";

const dirs: string[] = [];
const file = () => { const d = mkdtempSync(join(tmpdir(), "eng-")); dirs.push(d); return join(d, "default-engine.json"); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const choice = { instanceId: "fuigo", model: "m1" };

describe("bootEngineChoice", () => {
  it("awaits the probe on a first run and remembers the answer", async () => {
    const f = file(); let adopted: unknown = null;
    await bootEngineChoice({ hasBots: false, file: f, probe: async () => choice, adopt: c => { adopted = c; } });
    expect(adopted).toEqual(choice);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual(choice);
  });
  it("awaits the probe when bots exist but nothing is remembered", async () => {
    const f = file(); let adopted: unknown = null;
    await bootEngineChoice({ hasBots: true, file: f, probe: async () => choice, adopt: c => { adopted = c; } });
    expect(adopted).toEqual(choice);
  });
  it("returns at once on the remembered choice when bots exist, then refreshes", async () => {
    const f = file();
    await bootEngineChoice({ hasBots: false, file: f, probe: async () => choice, adopt: () => {} });
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let adopted: unknown = null;
    const { refreshed } = await bootEngineChoice({ hasBots: true, file: f, probe: async () => { await gate; return { instanceId: "claude", model: "m2" }; }, adopt: c => { adopted = c; } });
    expect(adopted).toEqual(choice);
    release(); await refreshed;
    expect(adopted).toEqual({ instanceId: "claude", model: "m2" });
    expect(readRememberedEngine(f)).toEqual({ instanceId: "claude", model: "m2" });
  });
  it("keeps the remembered choice when the refresh probe fails", async () => {
    const f = file();
    await bootEngineChoice({ hasBots: false, file: f, probe: async () => choice, adopt: () => {} });
    let adopted: unknown = null;
    const { refreshed } = await bootEngineChoice({ hasBots: true, file: f, probe: async () => { throw new Error("x"); }, adopt: c => { adopted = c; } });
    await refreshed;
    expect(adopted).toEqual(choice);
  });
  it("awaits the probe when the remembered engine is gone or no longer usable", async () => {
    const f = file();
    await bootEngineChoice({ hasBots: false, file: f, probe: async () => choice, adopt: () => {} });
    const adopted: unknown[] = [];
    await bootEngineChoice({ hasBots: true, file: f, usable: () => false, probe: async () => ({ instanceId: "claude", model: "m2" }), adopt: c => { adopted.push(c); } });
    expect(adopted).toEqual([{ instanceId: "claude", model: "m2" }]);
  });
  it("still returns at once when the remembered engine is usable", async () => {
    const f = file();
    await bootEngineChoice({ hasBots: false, file: f, probe: async () => choice, adopt: () => {} });
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const adopted: unknown[] = [];
    const { refreshed } = await bootEngineChoice({ hasBots: true, file: f, usable: c => c.instanceId === "fuigo", probe: async () => { await gate; return choice; }, adopt: c => { adopted.push(c); } });
    expect(adopted).toEqual([choice]);
    release(); await refreshed;
  });
  it("ignores a damaged memory file", () => { expect(readRememberedEngine("/nonexistent/x.json")).toBeNull(); });
});
