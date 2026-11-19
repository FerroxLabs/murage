// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { skillContentHash } from "./content-hash.ts";
import { scanSkill } from "./scan.ts";
import { SPECTOR_COMMIT } from "./spector-patterns.generated.ts";
import { SKILL_SCANNER_VERSION, type SkillScanInput, type SkillVerdict } from "./types.ts";

const root = fileURLToPath(new URL("../../skills-library/", import.meta.url));
const ids = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name).sort();
const shipped = JSON.parse(readFileSync(join(root, "scan-verdicts.json"), "utf8")) as {
  scannerVersion: number;
  spectorCommit: string;
  skills: Record<string, { verdict: SkillVerdict; contentHash: string; rules: string[] }>;
};

/** The same inputs as scripts/skill-guard/scan-library.ts: the manifest and SKILL.md, with no service calls. */
function inputFor(id: string): SkillScanInput {
  const manifest = JSON.parse(readFileSync(join(root, id, "manifest.json"), "utf8"));
  return {
    name: id,
    description: String(manifest.description ?? ""),
    triggerTerms: Array.isArray(manifest.triggerTerms) ? manifest.triggerTerms.map(String) : [],
    files: [{ path: "SKILL.md", content: readFileSync(join(root, id, "SKILL.md"), "utf8") }],
  };
}

describe("shipped library verdicts", () => {
  it("covers every shipped skill exactly once with the current scanner metadata", () => {
    expect(ids.length).toBeGreaterThan(0);
    expect(Object.keys(shipped.skills).sort()).toEqual(ids);
    expect(shipped.scannerVersion).toBe(SKILL_SCANNER_VERSION);
    expect(shipped.spectorCommit).toBe(SPECTOR_COMMIT);
  });

  it("binds every verdict to the shipped skill content", () => {
    for (const id of ids) {
      const row = shipped.skills[id];
      expect(row, id).toBeDefined();
      expect(["clean", "review", "blocked"], id).toContain(row.verdict);
      expect(row.contentHash, id).toBe(skillContentHash(inputFor(id)));
      expect(Array.isArray(row.rules), id).toBe(true);
      expect(row.rules.every((rule) => typeof rule === "string" && rule.length > 0), id).toBe(true);
      expect(new Set(row.rules).size, id).toBe(row.rules.length);
    }
  });

  it.each(["docs-auditor", "repro-pack", "security-questionnaire", "seo-aeo-desk"])("ships the actual local scan for %s", (id) => {
    const scan = scanSkill(inputFor(id));
    expect(shipped.skills[id]).toEqual({
      verdict: scan.verdict,
      contentHash: scan.contentHash,
      rules: [...new Set(scan.findings.map((finding) => finding.rule))],
    });
  });
});
