// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour adapted from OpenMausBot #2483 (Apache-2.0).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readPersistedJson } from "./persisted-state.ts";
import { parseSkillMd } from "./skills.ts";

it("reads a JSON file saved with a byte order mark", () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-bom-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, "﻿" + JSON.stringify({ keep: [1, 2] }));
    expect(readPersistedJson(file)).toEqual({ keep: [1, 2] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reads a SKILL.md saved with a byte order mark", () => {
  const parsed = parseSkillMd("﻿---\nname: bom-skill\ndescription: Saved in Notepad\n---\nDo the thing.\n");
  expect(parsed).not.toHaveProperty("error");
  expect(parsed).toMatchObject({ name: "bom-skill" });
});
