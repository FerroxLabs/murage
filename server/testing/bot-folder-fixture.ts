import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";
import { removeTempDir } from "./cleanup.ts";

let root: string | undefined;
const roots: string[] = [];
beforeEach(() => { root = undefined; });
/** A real isolated bot folder, shared only by the turns in this test. */
export function fixtureBotFolder(): string {
  if (!root) { root = mkdtempSync(join(tmpdir(), "murage-bot-fixture-")); roots.push(root); }
  const folder = join(root, "bot");
  mkdirSync(folder, { recursive: true });
  return folder;
}
afterAll(async () => { for (const folder of roots) await removeTempDir(folder); roots.length = 0; root = undefined; });

