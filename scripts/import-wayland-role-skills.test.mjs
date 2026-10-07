// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The role-skill importer writes the Apache-2.0 license line the rest of the
// skills library carries (Ferrox Labs, LLC holds the copyright).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("import-wayland-role-skills", () => {
  it("writes license: Apache-2.0 into the synthesized frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "role-skills-"));
    mkdirSync(join(root, "src", "skills", "beacon"), { recursive: true });
    writeFileSync(join(root, "src", "skills", "beacon", "demo.md"), "# Demo\n\nDoes a demo thing.\n");
    const out = join(root, "out");
    mkdirSync(out);
    execFileSync(process.execPath, [new URL("./import-wayland-role-skills.mjs", import.meta.url).pathname, "--source", join(root, "src"), "--out", out], { stdio: "ignore" });
    const text = readFileSync(join(out, "beacon-demo", "SKILL.md"), "utf8");
    const front = text.split("---")[1];
    expect(front).toMatch(/^license: Apache-2\.0$/m);
    expect(front).toMatch(/^  author: Ferrox Labs$/m);
  });
});
