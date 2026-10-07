// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The skills in skills-library are Ferrox Labs' own work: both importers must
// credit "Ferrox Labs" in frontmatter, except recorded MIT ports.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeFrontmatterAuthor } from "./import-wayland-skills.mjs";

describe("import-wayland-skills author", () => {
  it("rewrites the nested metadata author to Ferrox Labs", () => {
    const body = "---\nname: x\nlicense: Apache-2.0\nmetadata:\n  author: foundry-skills\n  version: \"1.0.0\"\n---\n\n# X\n\nauthor: foundry-skills stays in prose\n";
    const out = normalizeFrontmatterAuthor(body);
    expect(out).toContain("\n  author: Ferrox Labs\n");
    expect(out).toContain("author: foundry-skills stays in prose");
    expect(normalizeFrontmatterAuthor(out)).toBe(out);
  });

  it("leaves a recorded MIT port alone", () => {
    const body = "---\nname: x\nlicense: MIT\nmetadata:\n  author: wayland\n---\n\n# X\n";
    expect(normalizeFrontmatterAuthor(body)).toBe(body);
  });
});

describe("import-wayland-business-skills author", () => {
  it("writes Ferrox Labs and Apache-2.0 for every business skill", () => {
    const root = mkdtempSync(join(tmpdir(), "biz-skills-"));
    const put = (pack, id) => {
      mkdirSync(join(root, "src", pack, "skills", id), { recursive: true });
      writeFileSync(join(root, "src", pack, "skills", id, "SKILL.md"), "---\nname: x\n---\n\n# Title\n\nBody.\n");
    };
    put("business-finance", "finance-pl");
    put("business-sales", "sales-icp");
    const out = join(root, "out");
    mkdirSync(out);
    // Exits non-zero because the fixture holds only two of the catalogue skills.
    spawnSync(process.execPath, [new URL("./import-wayland-business-skills.mjs", import.meta.url).pathname, "--src", join(root, "src"), "--out", out], { stdio: "ignore" });
    const apache = readFileSync(join(out, "finance-pl", "SKILL.md"), "utf8").split("---")[1];
    expect(apache).toMatch(/^license: Apache-2\.0$/m);
    expect(apache).toMatch(/^  author: Ferrox Labs$/m);
    // Owner ruling 2026-10-02: sales-icp is Ferrox Labs' own work, no upstream credit.
    const own = readFileSync(join(out, "sales-icp", "SKILL.md"), "utf8").split("---")[1];
    expect(own).toMatch(/^license: Apache-2\.0$/m);
    expect(own).toMatch(/^  author: Ferrox Labs$/m);
    expect(own).not.toMatch(/attribution:/);
  });
});

describe("the 21 formerly MIT skills", () => {
  const ids = ["commerce-ugc-prompts", "content-about-page", "content-haro-reply", "market-audit", "market-landing", "market", "sales-contacts", "sales-icp", "sales-prospect", "sales-qualify", "chart-analysis", "learn-from-losses", "morning-prep", "multi-pane-analysis", "multi-symbol-scan", "pine-develop", "porting-pine-versions", "rebuild-from-screenshot", "replay-practice", "strategy-ab-test", "strategy-report"];
  const library = new URL("../skills-library/", import.meta.url).pathname;
  it("are Ferrox Labs' own work under Apache-2.0 with no upstream credit", () => {
    expect(ids).toHaveLength(21);
    for (const id of ids) {
      const head = readFileSync(join(library, id, "SKILL.md"), "utf8").split("---")[1];
      expect(head, id).toMatch(/^license: Apache-2\.0$/m);
      expect(head, id).toMatch(/^  author: Ferrox Labs$/m);
      expect(head, id).not.toMatch(/attribution:/);
      expect(head, id).not.toMatch(/MIT|wayland/);
    }
  });
});
