// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Default computer for new bots (CONTRACTS-B 2): config.computer.defaultForNewBots, "this" unless chosen,
// read at new-bot creation only, a bot's own Access > Computer choice wins after.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { DATA_DIR, defaultComputerForNewBots, loadConfig, parseConfigPatch, saveConfig } from "./config.ts";
import { resolveNewBotComputer, resolveNewBotComputerForCreation } from "./default-computer.ts";

describe("computer.defaultForNewBots in the config", () => {
  const file = join(DATA_DIR, "config.json");
  beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); rmSync(file, { force: true }); });

  it("defaults to this computer and persists a choice", () => {
    expect(defaultComputerForNewBots(loadConfig())).toBe("this");
    saveConfig(parseConfigPatch({ computer: { defaultForNewBots: "off" } }));
    expect(loadConfig().computer).toEqual({ defaultForNewBots: "off" });
    expect(defaultComputerForNewBots(loadConfig())).toBe("off");
  });

  it("rejects a value that is not one of the four, and any other field", () => {
    expect(() => parseConfigPatch({ computer: { defaultForNewBots: "everywhere" } })).toThrow();
    expect(() => parseConfigPatch({ computer: { defaultForNewBots: "vm", grants: true } })).toThrow();
  });

  it("accepts each of off, this, vm and cloud", () => {
    for (const choice of ["off", "this", "vm", "cloud"] as const) {
      expect(parseConfigPatch({ computer: { defaultForNewBots: choice } }).computer?.defaultForNewBots).toBe(choice);
    }
  });
});

describe("resolveNewBotComputer", () => {
  const desktop = { cloudHome: false, boxAvailable: false, vmAvailable: true };
  it("maps each choice to the bot's own computer value", () => {
    expect(resolveNewBotComputer("off", desktop)).toEqual({ computer: "off", fellBack: false });
    expect(resolveNewBotComputer("this", desktop)).toEqual({ computer: "local", fellBack: false });
    expect(resolveNewBotComputer("vm", desktop)).toEqual({ computer: "vm", fellBack: false });
    expect(resolveNewBotComputer("cloud", { ...desktop, boxAvailable: true })).toEqual({ computer: "cloud", fellBack: false });
  });
  it("falls back to this computer and says so where that engine does not exist", () => {
    expect(resolveNewBotComputer("cloud", desktop)).toEqual({ computer: "local", fellBack: true });
    expect(resolveNewBotComputer("vm", { ...desktop, vmAvailable: false })).toEqual({ computer: "local", fellBack: true });
    expect(resolveNewBotComputer("vm", { cloudHome: true, boxAvailable: false, vmAvailable: false })).toEqual({ computer: undefined, fellBack: true });
    expect(resolveNewBotComputer("vm", { ...desktop, cloudHome: true })).toEqual({ computer: undefined, fellBack: true });
    expect(resolveNewBotComputer("cloud", { cloudHome: true, boxAvailable: false, vmAvailable: false })).toEqual({ computer: undefined, fellBack: true });
  });
  it("leaves a Cloud home on its automatic choice for this computer, which has no desktop", () => {
    expect(resolveNewBotComputer("this", { cloudHome: true, boxAvailable: true, vmAvailable: false })).toEqual({ computer: undefined, fellBack: false });
  });
});

describe("VM availability before creation", () => {
  const desktop = { cloudHome: false, boxAvailable: false, vmMode: "shared" as const };

  it.each([
    { runtime: null, ready: false }, // no engine
    { runtime: "docker", ready: false }, // engine installed, VM not ready
    { runtime: null, ready: true }, // incomplete status cannot grant availability
  ])("falls back for unavailable VM status %j", async (status) => {
    const readVm = vi.fn(async () => status);
    expect(await resolveNewBotComputerForCreation("vm", desktop, readVm)).toEqual({ computer: "local", fellBack: true });
    expect(readVm).toHaveBeenCalledOnce();
  });

  it("waits for the status read and copies a ready shared VM", async () => {
    let answer!: (status: { runtime: string | null; ready: boolean }) => void;
    const status = new Promise<{ runtime: string | null; ready: boolean }>((resolve) => { answer = resolve; });
    const readVm = vi.fn(() => status);
    let finished = false;
    const pending = resolveNewBotComputerForCreation("vm", desktop, readVm).then((result) => { finished = true; return result; });
    await Promise.resolve();
    expect(readVm).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    answer({ runtime: "docker", ready: true });
    expect(await pending).toEqual({ computer: "vm", fellBack: false });
  });

  it("falls back when the availability read fails", async () => {
    const readVm = vi.fn(async () => { throw new Error("fixture status unavailable"); });
    expect(await resolveNewBotComputerForCreation("vm", desktop, readVm)).toEqual({ computer: "local", fellBack: true });
  });

  it("does not borrow the shared VM for a new per-bot desktop or a Cloud home", async () => {
    const readVm = vi.fn(async () => ({ runtime: "docker", ready: true }));
    expect(await resolveNewBotComputerForCreation("vm", { ...desktop, vmMode: "per-bot" }, readVm)).toEqual({ computer: "local", fellBack: true });
    expect(await resolveNewBotComputerForCreation("vm", { ...desktop, cloudHome: true }, readVm)).toEqual({ computer: undefined, fellBack: true });
    expect(readVm).not.toHaveBeenCalled();
  });

  it("does not inspect a VM for other defaults", async () => {
    const readVm = vi.fn(async () => ({ runtime: "docker", ready: true }));
    for (const choice of ["off", "this", "cloud"] as const) {
      expect(await resolveNewBotComputerForCreation(choice, desktop, readVm)).toEqual(resolveNewBotComputer(choice, { ...desktop, vmAvailable: false }));
    }
    expect(readVm).not.toHaveBeenCalled();
  });
});

describe("creation copies the default, existing bots are never changed", () => {
  let fixture: VerificationServer;
  let headers: Record<string, string>;
  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 18_899, span: 10_000 } });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret?: unknown };
    if (typeof proof.secret !== "string") throw new Error("Missing fixture desktop proof");
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 60_000);
  afterAll(async () => { await fixture?.close(); });

  it("the frame reports this computer until the owner chooses", async () => {
    const config = await call("GET", "/api/config");
    expect(config.newBotComputer).toBe("this");
  });

  it("copies the choice into a new bot, leaves older bots alone, and the bot's own choice wins", async () => {
    const { instances } = await call("GET", "/api/instances");
    const engine = instances.find((instance: { instanceId: string }) => instance.instanceId === "verification");
    const selection = { instanceId: "verification", model: engine.models.default };

    expect((await call("PATCH", "/api/config", { computer: { defaultForNewBots: "off" } })).newBotComputer).toBe("off");
    const first = await call("POST", "/api/bots", { name: "FirstOff", modelSelection: selection });
    expect(first.bot.computer).toBe("off");

    await call("PATCH", "/api/config", { computer: { defaultForNewBots: "this" } });
    const second = await call("POST", "/api/bots", { name: "SecondThis", modelSelection: selection });
    expect(second.bot.computer).toBe("local");
    const stillFirst = (await call("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === first.bot.id);
    expect(stillFirst.computer).toBe("off");

    // the bot's own Access > Computer choice always wins afterwards
    await call("PATCH", `/api/bots/${second.bot.id}`, { computer: "off" });
    await call("PATCH", "/api/config", { computer: { defaultForNewBots: "this" } });
    const kept = (await call("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === second.bot.id);
    expect(kept.computer).toBe("off");
  });

  it("falls back to this computer and says so when the hosted computer does not exist here", async () => {
    const { instances } = await call("GET", "/api/instances");
    const engine = instances.find((instance: { instanceId: string }) => instance.instanceId === "verification");
    await call("PATCH", "/api/config", { computer: { defaultForNewBots: "cloud" } });
    const made = await call("POST", "/api/bots", { name: "NoBox", modelSelection: { instanceId: "verification", model: engine.models.default } });
    expect(made.bot.computer).toBe("local");
    expect(typeof made.computerNotice).toBe("string");
  });

  it("returns the fallback notice when a new bot has no private VM, without changing the saved default", async () => {
    const { instances } = await call("GET", "/api/instances");
    const engine = instances.find((instance: { instanceId: string }) => instance.instanceId === "verification");
    // Per-bot mode has no VM for a just-created bot. This also keeps the isolated fixture from probing host runtimes.
    await call("PATCH", "/api/config", { localVm: { mode: "per-bot" }, computer: { defaultForNewBots: "vm" } });
    const made = await call("POST", "/api/bots", { name: "NoLocalVm", modelSelection: { instanceId: "verification", model: engine.models.default } });
    expect(made.bot.computer).toBe("local");
    expect(made.computerNotice).toBe("That computer is not available here, so this assistant started on this computer.");
    expect((await call("GET", "/api/config")).newBotComputer).toBe("vm");
    await call("PATCH", "/api/config", { computer: { defaultForNewBots: "this" } });
    expect((await call("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === made.bot.id).computer).toBe("local");
  });
});
