// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md), row E4: a refused roster save switches the start to read-only, and the disk's work waits for the next
// start. A normal start check, then the disk goes to zero free, then the real boot step (reconcileTeamIdentities) drops a ghost sharing entry in memory and its roster
// save (writeFileAtomic) fails with the OS's ENOSPC: the step is named in skippedAtStart, the mode is read-only, and bots.json still lacks the change. After a
// restart with space the same step makes it. Needs a real small filesystem (`--tmpfs /strict`); skipped elsewhere. HEADLESS ONLY.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STRICT, onStrictMount } from "./testing/strict-fs.ts";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "testing", "team-identities-switch-child.ts");
function child(scenario: string, home: string, ballast: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [CHILD, scenario, ballast], {
    encoding: "utf8", timeout: 120_000, cwd: join(dirname(CHILD), "..", ".."),
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: join(home, ".murage"), TEAM_SWITCH_CHILD: "1", MURAGE_TEST_ENV_SCRUBBED: "1" },
  });
  const line = result.stdout.split("\n").find(l => l.startsWith("TSRESULT "));
  expect(line, `${result.stdout.slice(-2000)}\n${result.stderr.slice(-4000)}`).toBeDefined();
  return JSON.parse(line!.slice("TSRESULT ".length)) as Record<string, unknown>;
}

describe("E4 a refused roster save switches to read-only, disk to the next start", () => {
  it.skipIf(!onStrictMount)("the roster save fails with ENOSPC after the in-memory change; the next start has the change", { timeout: 300_000 }, () => {
    const root = join(STRICT, "e4"); rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
    try {
      const ballast = join(root, "ballast");
      expect(child("prepare", root, ballast).before).toEqual([{ id: "11111111-1111-4111-8111-111111111111", name: "Gone" }]);
      const refused = child("refused", root, ballast);
      expect(refused).toMatchObject({ startMode: "normal", readOnly: true, reason: "teams.reconcileIdentities", skipped: ["teams.reconcileIdentities"], writeError:{code:"ENOSPC",atomic:true}, memoryTeams:[], serving:true,healthDiskMode:"read-only" });
      expect(refused.sharedWith, "bots.json still lacks the change").toEqual([{ id: "11111111-1111-4111-8111-111111111111", name: "Gone" }]);
      expect(child("retry", root, ballast)).toMatchObject({ startMode: "normal", readOnly: false, sharedWith: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
