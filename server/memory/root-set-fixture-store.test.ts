// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pins the fail-closed intent behind the root-set fixture: a memory save on a turn the outside store cannot vouch for is refused with
// a durable-mark error, never let through unmarked. The fixture opens the store the way the real boot does (index.ts, before any
// save can run); with it left closed the same build refuses.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { restartOutsideForTests } from "../email/external-marks.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { longThreadsV5 } from "./testing/root-set-fixture.ts";

let copyDir: string;
beforeEach(() => { restartOutsideForTests(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); copyDir = mkdtempSync(join(tmpdir(), "murage-rsfs-")); });
afterEach(() => { closeDatabase(); restartOutsideForTests(); removeTempDirSync(copyDir); });

it("with the outside store not open, a memory save is refused (fail closed)", async () => {
  await expect(longThreadsV5(join(copyDir, "v5.db"), 1, 2, { outsideStore: false })).rejects.toThrow("Murage could not record this change.");
});
it("with the outside store open, the same fixture builds", async () => {
  await expect(longThreadsV5(join(copyDir, "v5.db"), 1, 2)).resolves.toBe(join(copyDir, "v5.db"));
});
