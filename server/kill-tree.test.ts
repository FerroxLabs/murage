// The drivers spawn their CLI detached so that stopping a turn also stops
// whatever the CLI started (its MCP servers). That guarantee is the whole
// contract of killTree, so it is what gets tested: a grandchild must not
// survive the kill on either platform.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { killTree } from "./kill-tree.ts";

const IDLE = "setInterval(() => {}, 1000)";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("killTree", () => {
  it("reaps a grandchild, not just the process it was handed", async () => {
    // a stand-in CLI: spawns one helper, reports its pid, then idles
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { stdio: "ignore" });` +
          `console.log(c.pid); ${IDLE}`,
      ],
      { stdio: ["ignore", "pipe", "ignore"], detached: true },
    );
    const grandchild = await new Promise<number>((resolve) =>
      parent.stdout!.once("data", (c) => resolve(Number(String(c).trim()))),
    );
    expect(grandchild).toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(true);

    killTree(parent);

    // wait for both, and read the parent's death off the child object: a
    // POSIX parent stays a live pid as a zombie until node reaps it
    const exited = () => parent.exitCode !== null || parent.signalCode !== null;
    for (let i = 0; i < 100 && (alive(grandchild) || !exited()); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(alive(grandchild)).toBe(false);
    expect(exited()).toBe(true);
  });
});
