import { describe, expect, it, vi } from "vitest";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { typedOpenCodeModel, typedOpenCodeModelId, acceptsTypedOpenCodeModel } from "../../../shared/opencode-model-id.ts";
import { declareTypedOpenCodeModel } from "./opencode-typed-model.ts";

describe("OpenCode ids typed by hand", () => {
  it("validates a typed selection at the model admission boundary", () => {
    expect(typedOpenCodeModelId(" venice/new-model ")).toBe("typed::venice/new-model");
    expect(acceptsTypedOpenCodeModel("opencodeGo", "typed::venice/new-model")).toBe(true);
    for (const id of ["typed::venice/a b", "typed::venice/$(touch-x)", "typed::venice/a;id", "typed::venice/a`id`", "typed::venice/a\nb", "typed::venice/", "typed:: venice/a"]) {
      expect(typedOpenCodeModel(id)).toBeNull();
      expect(acceptsTypedOpenCodeModel("opencodeGo", id)).toBe(false);
    }
    expect(acceptsTypedOpenCodeModel("fuigo", "typed::venice/new-model")).toBe(false);
  });
  it("declares only typed ids as JSON while preserving the provider's existing configuration", () => {
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { venice: { options: { timeout: 1 }, models: { old: { name: "Old" } } } } }) };
    expect(declareTypedOpenCodeModel(env, "typed::venice/new-model")).toBe("venice/new-model");
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({ provider: { venice: { options: { timeout: 1 }, models: { old: { name: "Old" }, "new-model": {} } } } });
    const before = env.OPENCODE_CONFIG_CONTENT;
    expect(declareTypedOpenCodeModel(env, "venice/retired")).toBeUndefined();
    expect(declareTypedOpenCodeModel(env, "typed::venice/a;id")).toBeUndefined();
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(before);
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { createOpenCodeDriver, discoverOpenCodeModels, resetOpenCodeModelCache } from "./opencode-go.ts";

it.skipIf(process.platform === "win32")("an explicit Refresh refetches; a second click inside the 60 s window is held to one refetch (B89 throttle), and the next one after the window refetches again", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-model-refresh-"));
  const cli = join(home, "opencode");
  const offered = join(home, "offered"), cached = join(home, "cached");
  writeFileSync(cached, "venice/old\n");
  writeFileSync(offered, "venice/new\n");
  writeFileSync(cli, '#!/bin/sh\nif [ "$2" = --refresh ]; then cp "$OFFERED" "$CACHED"; else cat "$CACHED"; fi\n', { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: home, OFFERED: offered, CACHED: cached };
  try {
    resetOpenCodeModelCache();
    expect((await discoverOpenCodeModels(env, cli)).default).toBe("venice/old");
    expect((await discoverOpenCodeModels(env, cli, { refresh: true })).default).toBe("venice/new");
    writeFileSync(offered, "venice/newer\n");
    expect((await discoverOpenCodeModels(env, cli, { refresh: true })).default).toBe("venice/new");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect((await discoverOpenCodeModels(env, cli, { refresh: true })).default).toBe("venice/newer");
  } finally { vi.useRealTimers(); resetOpenCodeModelCache(); await removeTempDir(home); }
});

it("runs a typed id through ACP model selection with the fake engine", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-typed-turn-"));
  const instance = await createOpenCodeDriver(async () => ({ default: "venice/old", options: [{ id: "venice/old", label: "Old" }], source: "live" })).create({
    instanceId: "typed-test", displayName: "OpenCode", enabled: true,
    environment: { HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, OPENCODE_API_KEY: "fixture-key", FAKE_ACP_MODELS: "venice/old" },
    config: { cli: resolve("server/testing/fake-acp-cli.ts"), fullAuto: false, workspace: home },
  });
  const recorder = recordEvents(instance.adapter);
  try {
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "typed-thread", text: "hello", model: "typed::venice/new" });
    expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId, 20_000)).toMatchObject({ ok: true });
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "session.started", model: "venice/new" }));
  } finally { recorder.stop(); await instance.dispose(); await removeTempDir(home); }
});

it.each(["flux/flux-auto", "FLUX/x", "Flux/flux-auto", "flux-other/x"])("refuses reserved typed %s at admission and decode", id => {
  expect(typedOpenCodeModelId(id)).toBeNull();
  expect(acceptsTypedOpenCodeModel("opencodeGo", `typed::${id}`)).toBe(false);
  expect(typedOpenCodeModel(`typed::${id}`)).toBeNull();
  const env = {};
  expect(declareTypedOpenCodeModel(env, `typed::${id}`)).toBeUndefined();
  expect(env).toEqual({});
  expect(acceptsTypedOpenCodeModel("opencodeGo", "typed::venice/x")).toBe(true);
});

it("refuses a previously saved typed Flux ID in the ACP turn path", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-typed-refusal-"));
  const instance = await createOpenCodeDriver(async () => ({ default: "venice/old", options: [{ id: "venice/old", label: "Old" }], source: "live" })).create({
    instanceId: "typed-refusal", displayName: "OpenCode", enabled: true,
    environment: { HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, OPENCODE_API_KEY: "fixture-key", FAKE_ACP_MODELS: "venice/old" },
    config: { cli: resolve("server/testing/fake-acp-cli.ts"), fullAuto: false, workspace: home },
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await expect(instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "saved-flux", text: "hello", model: "typed::flux/flux-auto" })).rejects.toThrow("Invalid typed OpenCode model");
    expect(recorder.events.some(event => event.type === "session.started")).toBe(false);
  } finally { recorder.stop(); await instance.dispose(); await removeTempDir(home); }
});
