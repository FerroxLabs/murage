// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ENGINE-CHECK-FOLDER-1018 decision 2: OpenCode project config is off for the set-up check folder, and stays on for a picked folder.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDir, removeTempDirSync } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { engineCheckFolder, engineCheckHost } from "../../engine-reply-check.ts";
import type { ModelCatalog } from "../../contracts.ts";
import { createOpenCodeDriver, murageOwnsWorkingFolder } from "./opencode-go.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const catalog = (...ids: string[]): ModelCatalog => ({ default: ids[0]!, options: ids.map((id) => ({ id, label: id })) });
const posixOnly = process.platform === "win32" ? describe.skip : describe;
// The check folder lives in a temp system root here, never in the machine's real /tmp; the driver's predicate sees the same root.
const systemRoot = mkdtempSync(join(tmpdir(), "opencode-check-root-"));
beforeEach(() => { vi.spyOn(engineCheckHost, "systemRoot").mockReturnValue(systemRoot); });
afterAll(() => { vi.restoreAllMocks(); removeTempDirSync(systemRoot); });

posixOnly("OpenCode in the set-up check folder", () => {
  it("owns the check folder and what is below it, not the base or a picked folder", () => {
    const run = engineCheckFolder();
    expect(murageOwnsWorkingFolder(run)).toBe(true);
    expect(murageOwnsWorkingFolder(join(run, "sub"))).toBe(true);
    expect(murageOwnsWorkingFolder(dirname(run))).toBe(false);
    expect(murageOwnsWorkingFolder(join(tmpdir(), "a-picked-project"))).toBe(false);
  });

  it.each([
    ["the set-up check folder", () => engineCheckFolder(), "1"],
    ["a picked project folder", () => join(tmpdir(), "murage-opencode-picked-project"), undefined],
  ])("applyTurnEnv sets OPENCODE_DISABLE_PROJECT_CONFIG for a turn in %s as needed", async (_label, folder, expected) => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-opencode-engchk-"));
    try {
      const dump = join(scratch, "env.json");
      const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
      const instance = await driver.create({
        instanceId: "opencode-engchk",
        displayName: "OpenCode",
        environment: { OPENCODE_API_KEY: "secret-value", FAKE_ACP_DUMP: dump, FAKE_ACP_MODELS: "opencode-go/minimax-m3" },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: true },
      });
      const recorder = recordEvents(instance.adapter);
      const cwd = folder();
      mkdirSync(cwd, { recursive: true });
      await instance.adapter.sendTurn({ threadId: "t-engchk", text: "go", model: "opencode-go/minimax-m3", cwd });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      const child = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(child.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe(expected);
      await instance.dispose();
    } finally {
      await removeTempDir(scratch);
    }
  });
});
