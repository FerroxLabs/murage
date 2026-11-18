// Owner: sc-safety (import-time guards). The isolated runner owns process containment.
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFunction } from "./source-extract.ts";
import { removeTempDirSync } from "./cleanup.ts";
const file = new URL("../index.ts", import.meta.url);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
it.each([
  'import fs from "node:fs"; fs.writeFileSync("/outside-fixture-write", "x");',
  'import net from "node:net"; net.connect({port: 1,host:"127.0.0.1"});',
  'import cp from "node:child_process"; cp.execFileSync(process.execPath,["-e", ""]);',
  'import {Worker} from "node:worker_threads"; new Worker("", {eval:true});',
])("H-SCOPE-5' guards import side effects: %s", async body => {
  const root = mkdtempSync(join(tmpdir(), "import-containment-")); roots.push(root);
  const module = join(root, "side-effect.mjs"); writeFileSync(module, body + " export const value=1;");
  const unit = extractFunction({file, text: `import {value} from ${JSON.stringify(module)}; function selected(){return value;}`, select:"selected"});
  await expect(unit.preflight()).rejects.toThrow("FIXTURE_IMPORT_SIDE_EFFECT");
});
