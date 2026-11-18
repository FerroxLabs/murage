// SPDX-License-Identifier: AGPL-3.0-or-later
// Applies one committed mutant patch (testing/mutants/<group>-<row>.patch) to the working tree: `node testing/apply-mutant.ts <group>-<row>`.
// The suite run after it must FAIL (never time out); the tree is restored with `git checkout -- <files>` by the caller.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2];
if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) { console.error("usage: apply-mutant.ts <group>-<row>"); process.exit(2); }
const patch = join(root, "testing", "mutants", `${name}.patch`);
if (!existsSync(patch)) { console.error(`no mutant ${name}`); process.exit(2); }
execFileSync("git", ["apply", "--whitespace=nowarn", patch], { cwd: root, stdio: "inherit" });
console.log(`mutant ${name} applied`);
