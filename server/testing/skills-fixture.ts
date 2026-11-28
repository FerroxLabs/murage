// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 K8: the generated skills library the skills lane and the accept lane both stand on. One generator, so the
// figures the Skills page claims (2,262 = 2,247 library + 4 built in + 11 yours) are counted from files, not typed twice.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_LIBRARY = 2_247;
export const FIXTURE_BUILTIN = 4;
export const FIXTURE_YOURS = 11;
export const FIXTURE_TOTAL = FIXTURE_LIBRARY + FIXTURE_BUILTIN + FIXTURE_YOURS;

/** Category labels the generator cycles through; labels the index has no plain name for fold into Other. */
export const FIXTURE_CATEGORIES = [
  "writing", "health-wellness", "software-development", "finance", "research", "sales", "support", "legal", "design", "education",
  "operations", "marketing", "data", "travel",
] as const;

const WORDS = ["report", "invoice", "meeting", "outline", "review", "summary", "plan", "checklist", "brief", "audit", "draft", "notes"];

export function skillFixtureId(index: number): string {
  return `${WORDS[index % WORDS.length]}-${WORDS[(index * 7 + 3) % WORDS.length]}-${String(index).padStart(5, "0")}`;
}

/** Writes `count` library skills under `root`, each with a manifest and a SKILL.md, spread over the fixture categories. */
export function writeSkillsFixture(root: string, count: number = FIXTURE_LIBRARY): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = skillFixtureId(index);
    const description = `Steps for a ${WORDS[index % WORDS.length]} task number ${index}.`;
    const category = FIXTURE_CATEGORIES[index % FIXTURE_CATEGORIES.length];
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "manifest.json"), JSON.stringify({ id, name: id, description, version: "1.0.0", defaultEnabled: false, triggerTerms: [WORDS[index % WORDS.length]], requiredCapabilities: [] }));
    writeFileSync(join(root, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\nmetadata:\n  category: "${category}"\n---\nFollow a clear method for ${id}.\n`);
    ids.push(id);
  }
  return ids;
}
