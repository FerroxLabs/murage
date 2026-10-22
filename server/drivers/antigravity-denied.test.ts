// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A turn in accept-edits (an instance that does not skip agy's own permissions) has run_command denied. agy then
// ends with an empty response and result.denied_actions; the Linux real-engine gate showed a blank reply. The turn
// carries one plain line, with no engine advice; at Ask it is the Ask stop's own note.
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { ASK_STOP_NOTE } from "./ask-stop.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");
const NOTE = "Antigravity could not run a command on this turn, so it stopped without a reply.";

describe("Antigravity denied action with an empty reply", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let home = "";

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-agy-denied-"));
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    removeTempDirSync(home);
  });

  const run = async (environment: Record<string, string>, level: { askLevel?: true } = {}) => {
    instance = await AntigravityDriver.create({
      instanceId: "agy-denied",
      displayName: undefined,
      environment: { HOME: home, ...environment },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-denied", text: "run ls", routeAsks: true, ...level });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const titles = recorder.events
      .filter((e) => e.type === "item.started" && (e as any).toolKind === "notice")
      .map((e) => (e as any).title as string);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")
      .map((e) => (e as any).text as string);
    return { titles, texts };
  };

  it("shows one plain line when an accept-edits turn's command was denied and agy wrote no reply", async () => {
    const { titles, texts } = await run({ FAKE_AGY_DENIED_COMMAND: "1" });
    expect(texts).toEqual([]);
    expect(titles).toEqual([NOTE]);
    expect(NOTE).not.toMatch(/—|\bsafe|\bunsafe|\bsafety|another engine/i);
  }, 10_000);

  it("at Ask the line is the Ask stop's own note, once", async () => {
    const { titles, texts } = await run({ FAKE_AGY_DENIED_COMMAND: "1" }, { askLevel: true });
    expect(texts).toEqual([]);
    expect(titles).toEqual([ASK_STOP_NOTE]);
  }, 10_000);

  it("adds nothing to a turn that has a reply", async () => {
    const { titles, texts } = await run({});
    expect(texts).toEqual(["done from fake agy"]);
    expect(titles).toEqual([]);
  }, 10_000);
});
