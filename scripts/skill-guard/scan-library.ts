// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scans every library skill (reads skills-library/ only) and writes
// skills-library/scan-verdicts.json. Prints the counts a person reviews
// before any severity is locked in.
// Run: node --experimental-strip-types scripts/skill-guard/scan-library.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanSkill } from "../../server/skill-guard/scan.ts";
import { SPECTOR_COMMIT } from "../../server/skill-guard/spector-patterns.generated.ts";
import { SKILL_SCANNER_VERSION } from "../../server/skill-guard/types.ts";

const root = join(import.meta.dirname, "..", "..", "skills-library");
const skills: Record<string, { verdict: string; contentHash: string; rules: string[] }> = {};
const byRule = new Map<string, number>();
const examples = new Map<string, string[]>();
for (const id of readdirSync(root).filter((name) => !name.startsWith(".") && !name.endsWith(".json")).sort()) {
  const manifest = JSON.parse(readFileSync(join(root, id, "manifest.json"), "utf8"));
  const content = readFileSync(join(root, id, "SKILL.md"), "utf8");
  const scan = scanSkill({ name: id, description: String(manifest.description ?? ""), triggerTerms: Array.isArray(manifest.triggerTerms) ? manifest.triggerTerms.map(String) : [], files: [{ path: "SKILL.md", content }] });
  const rules = [...new Set(scan.findings.map((f) => f.rule))];
  skills[id] = { verdict: scan.verdict, contentHash: scan.contentHash, rules };
  for (const rule of rules) {
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    const list = examples.get(rule) ?? [];
    if (list.length < 3) list.push(`${id}: ${scan.findings.find((f) => f.rule === rule)!.evidence}`);
    examples.set(rule, list);
  }
}
writeFileSync(join(root, "scan-verdicts.json"), `${JSON.stringify({ scannerVersion: SKILL_SCANNER_VERSION, spectorCommit: SPECTOR_COMMIT, skills }, null, 1)}\n`);
const count = (verdict: string) => Object.values(skills).filter((s) => s.verdict === verdict).length;
console.log(`skills ${Object.keys(skills).length}: clean ${count("clean")}, review ${count("review")}, blocked ${count("blocked")}`);
for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${rule}\n        ${examples.get(rule)!.join("\n        ")}`);
console.log("\nblocked:", Object.entries(skills).filter(([, s]) => s.verdict === "blocked").map(([id, s]) => `${id} (${s.rules.join(", ")})`).join("\n  "));
