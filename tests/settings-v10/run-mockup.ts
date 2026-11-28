// Runs the v10 mockup generator and its checks from a throwaway copy, so nothing is written into the tree.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GEN = join(dirname(fileURLToPath(import.meta.url)), "mockup", "_gen");

export function withScratchGen<T>(run: (scratchGen: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "sv10-accept-"));
  try {
    const gen = join(root, "_gen");
    cpSync(GEN, gen, { recursive: true });
    return run(gen);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function pythonOut(args: string[], cwd: string): string {
  return execFileSync("python3", ["-BI", ...args], { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
}
