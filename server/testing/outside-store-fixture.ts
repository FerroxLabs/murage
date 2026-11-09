// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect } from "vitest";
import { restartOutsideForTests, wireOutsideStore } from "../email/external-marks.ts";
import { fileOutsideStore } from "../outside-store.ts";
import { removeTempDirSync } from "./cleanup.ts";

/** Register after the suite's database and mark resets. */
export function useOutsideStoreFixture(): void {
  const roots: string[] = [];
  beforeEach(() => {
    restartOutsideForTests();
    const root = mkdtempSync(join(tmpdir(), "murage-outside-"));
    roots.push(root);
    expect(wireOutsideStore(fileOutsideStore(join(root, "outside-state.jsonl")))).toBe(true);
  });
  afterAll(() => { for (const root of roots) removeTempDirSync(root); });
}
