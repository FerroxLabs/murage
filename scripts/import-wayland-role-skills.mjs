#!/usr/bin/env node
// Import Wayland's 88 role skills — the ones the 28 specialists actually
// reference. These are NOT in the 2,106-skill pack: they live as plain
// markdown at waylandteams/skills/<role>/<name>.md and the id a specialist
// cites is `<role>-<name>`. They carry no frontmatter, and Murage requires
// SKILL.md to start with `---` (skill-library.ts:62), so it is synthesized
// from the first heading and the role.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

const SRC = "/Volumes/Mando/wayland/app/resources/builtin-extensions/waylandteams/skills";
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "skills-library";
const yaml = (s) => JSON.stringify(String(s ?? "").replace(/\s+/g, " ").trim());

let written = 0, skipped = 0, existing = 0;
for (const role of readdirSync(SRC).sort()) {
  const roleDir = join(SRC, role);
  if (!statSync(roleDir).isDirectory()) continue;
  for (const file of readdirSync(roleDir).sort()) {
    if (extname(file) !== ".md") continue;
    const id = `${role}-${basename(file, ".md")}`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) { skipped++; continue; }
    const dir = join(OUT, id);
    if (existsSync(join(dir, "SKILL.md"))) { existing++; continue; }
    const body = readFileSync(join(roleDir, file), "utf8").trim();
    const heading = (body.match(/^#\s+(.+)$/m)?.[1] ?? id).trim();
    // First real paragraph after the heading, as the description.
    const para = body.split(/\n{2,}/).find((b) => b.trim() && !b.trim().startsWith("#")) ?? heading;
    const description = para.replace(/\s+/g, " ").trim().slice(0, 300);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"),
      `---\nname: ${id}\ndescription: ${yaml(description)}\nmetadata:\n  author: wayland\n  version: "1.0.0"\n  category: ${yaml(role)}\n---\n\n${body}\n`);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      id, name: heading, version: "1.0.0", description,
      defaultEnabled: false,
      triggerTerms: [role, ...basename(file, ".md").split("-")].filter(Boolean),
      requiredCapabilities: [],
    }, null, 2) + "\n");
    written++;
  }
}
console.log(`role skills written ${written}, already present ${existing}, skipped ${skipped}`);
