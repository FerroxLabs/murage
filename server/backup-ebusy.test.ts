// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Kimi audit #5: a file another program holds open on Windows (EBUSY, a
// sharing violation) in a bot's folder is left out and listed, like an
// unreadable one. Murage's own records stay strict.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  const busy = (path: unknown) => typeof path === "string" && (path.endsWith("locked.pst") || (process.env.EBUSY_RECORD === "1" && path.endsWith("bots.json")));
  const openSync = ((path: unknown, ...rest: unknown[]) => { if (busy(path)) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY", path }); return (real.openSync as (...a: unknown[]) => number)(path, ...rest); }) as typeof real.openSync;
  return { ...real, openSync, default: { ...real, openSync } };
});
const { withOfflineInstallation } = await import("./installation-database-snapshot.ts");
const { stageInstallationStateWhileOwned } = await import("./installation-state-snapshot.ts");
const { backupFixture } = await import("./testing/backup-fixture.ts");

it("a sharing-locked file in a bot's folder is skipped and listed", async () => {
  const f = backupFixture();
  mkdirSync(join(f.data, "workspaces", "bot"), { recursive: true }); writeFileSync(join(f.data, "workspaces", "bot", "locked.pst"), "mail");
  try {
    await withOfflineInstallation(f.data, async installation => {
      const stage = await stageInstallationStateWhileOwned(installation, f.parent);
      expect(stage.manifest.skipped).toContainEqual({ path: "workspaces/bot/locked.pst", reason: "unreadable" });
      rmSync(stage.directory, { recursive: true, force: true });
    });
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
});
it("a sharing-locked record of Murage's own still stops the backup", async () => {
  const f = backupFixture(); process.env.EBUSY_RECORD = "1";
  try {
    await expect(withOfflineInstallation(f.data, installation => stageInstallationStateWhileOwned(installation, f.parent))).rejects.toThrow();
  } finally { delete process.env.EBUSY_RECORD; f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
});
