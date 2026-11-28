// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";
import type { ProviderInstance } from "../../contracts.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { DevinAgentDriver, devinSignedIn } from "./devin.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
useOutsideStoreFixture();

let root: string | undefined;
let instance: ProviderInstance | undefined;
let events: ReturnType<typeof recordEvents> | undefined;
afterEach(async () => {
  events?.stop();
  await instance?.dispose();
  if (root) await removeTempDir(root);
  root = undefined;
  instance = undefined;
  events = undefined;
});

async function create(mode: string, fullAuto: boolean, overrides: Record<string, string> = {}) {
  root = mkdtempSync(join(tmpdir(), "murage-devin-fixture-"));
  const launch = join(root, "launch.json");
  const rpc = join(root, "rpc.json");
  const input = {
    instanceId: "fixture-devin", displayName: "Devin", enabled: true, config: { cli, fullAuto },
    environment: {
      WINDSURF_API_KEY: "fixture-key",
      FAKE_ACP_DEVIN_MODE: mode,
      FAKE_ACP_MODELS: "fixture/model-a,fixture/model-b",
      FAKE_ACP_DUMP: launch,
      FAKE_ACP_RPC_DUMP: rpc,
      ...overrides,
    },
  };
  instance = await DevinAgentDriver.create(input);
  events = recordEvents(instance.adapter);
  return { instance, events, launch, rpc, input };
}

it.each([false, true])("runs Devin in Ask mode with the picked model, full=%s", async fullAuto => {
  expect(BUILT_IN_DRIVERS).toContain(DevinAgentDriver);
  const { instance, events, launch } = await create("accept", fullAuto);
  const { turnId } = await instance.adapter.sendTurn({ threadId: "fixture", cwd: fixtureBotFolder(), text: "hello", model: "fixture/model-b" });
  expect(await events.until(event => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
  expect(events.events).toContainEqual(expect.objectContaining({ type: "session.started", model: "fixture/model-b" }));
  const calls = JSON.parse(readFileSync(`${launch}.config.json`, "utf8"));
  expect(calls).toContainEqual(expect.objectContaining({ params: expect.objectContaining({ configId: "mode", value: "ask" }) }));
});

it("ends the turn before prompting if Devin does not confirm Ask mode", async () => {
  const { instance, events, rpc } = await create("refuse", true);
  const { turnId } = await instance.adapter.sendTurn({ threadId: "fixture", cwd: fixtureBotFolder(), text: "hello", model: "agent-default" });
  expect(await events.until(event => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: false });
  expect(JSON.parse(readFileSync(rpc, "utf8"))).not.toContain("session/prompt");
});

it("recognizes the credential file from the CLI's XDG data root", () => {
  root = mkdtempSync(join(tmpdir(), "murage-devin-credentials-"));
  const data = join(root, "data");
  const devin = join(data, "devin");
  mkdirSync(devin, { recursive: true });
  writeFileSync(join(devin, "credentials.toml"), "fixture");
  expect(devinSignedIn({ HOME: root, XDG_DATA_HOME: data }, "linux")).toBe(true);
  expect(devinSignedIn({ HOME: root, XDG_DATA_HOME: join(root, "other") }, "linux")).toBe(false);
});

it("publishes all 145 advertised models without pinning each one during discovery", async () => {
  const ids = Array.from({ length: 145 }, (_, index) => `fixture-model-${index}`);
  const { instance: opened, rpc, input } = await create("accept", false, { FAKE_ACP_MODELS: ids.join(",") });
  await opened.refreshModels?.({ manual: true });
  expect(opened.models.options.map(option => option.id)).toEqual(["agent-default", ...ids]);
  expect(JSON.parse(readFileSync(rpc, "utf8"))).not.toContain("session/set_config_option");
  await opened.dispose();
  instance = await DevinAgentDriver.create(input);
  expect(instance.models.options.map(option => option.id)).toEqual(["agent-default", ...ids]);
});

it("cancels a standing-only permission offer even at Full access", async () => {
  const { instance, events, launch } = await create("accept", true, {
    FAKE_ACP_MODE: "permission-always-only",
    FAKE_ACP_GH15_REPORT: "1",
  });
  const { turnId } = await instance.adapter.sendTurn({ threadId: "fixture", cwd: fixtureBotFolder(), text: "hello", model: "agent-default" });
  await events.until(event => event.type === "turn.completed" && event.turnId === turnId);
  expect(events.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: expect.stringContaining("offered no way to allow") }));
  expect(existsSync(join(dirname(launch), "gh15-report.md"))).toBe(false);
});
