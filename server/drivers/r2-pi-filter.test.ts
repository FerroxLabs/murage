import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { releaseNativeAnswer } from "./engine-input.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function run(outcome: string, mode = "bound", missing = false) {
  const root = mkdtempSync(join(tmpdir(), "r2-pi-filter-")); roots.push(root);
  const status = join(root, missing ? "missing/status" : "status");
  const child = spawnSync(process.execPath, ["--experimental-strip-types",
    fileURLToPath(new URL("../testing/r2-pi-filter.fixture.mjs", import.meta.url)), root, outcome, mode, status],
  { encoding: "utf8", timeout: 10_000, env: { ...process.env, MURAGE_PI_GATE_MODE_FILE: "", MURAGE_PI_GATE_STATUS_FILE: "" } });
  return { root, status, child };
}
describe("LASTRESORT §7.2 Pi filter process boundary", () => {
  it("T-PI-MODE: reload reads the current per-turn MODE file", () => {
    const { root, status, child } = run("reload", "open");
    expect(child.signal).toBe("SIGKILL");
    expect(readFileSync(status, "utf8")).toBe("refuse.pi.filter");
    expect(existsSync(join(root, "accepted.json"))).toBe(false);
  });
  it("T-PI-FILTER-AFTER-REVOKE", () => {
    const f = consumingFixture();
    try {
      f.flip();
      expect(() => releaseNativeAnswer(f.binding, "pi:answer", "late", () => { throw Error("must not write"); })).toThrow("MEMORY_CONTEXT_REVOKED");
      const { root, status, child } = run("partial");
      expect(child.signal).toBe("SIGKILL");
      expect(readFileSync(status, "utf8")).toBe("refuse.pi.filter");
      expect(existsSync(join(root, "accepted.json"))).toBe(false);
    } finally { f.close(); }
  });
  for (const outcome of ["partial", "count", "malformed", "throw", "untrusted"]) {
    it(`T-PI-FILTER-${outcome.toUpperCase()}`, () => {
      const { root, status, child } = run(outcome);
      expect(child.signal).toBe("SIGKILL");
      expect(readFileSync(status, "utf8")).toBe("refuse.pi.filter");
      expect(existsSync(join(root, "accepted.json"))).toBe(false);
      expect(child.stdout).toBe("");
      expect(child.stderr).not.toContain("private-path-sentinel");
    });
  }
  it.each([true, false])("T-PI-FILTER-STATUS-WRITE-FAILS: missing=%s (false is the green control)", missing => {
    const { root, status, child } = run("partial", "bound", missing);
    expect(child.signal).toBe("SIGKILL");
    expect(existsSync(join(root, "accepted.json"))).toBe(false);
    if (missing) expect(existsSync(status)).toBe(false);
    else expect(readFileSync(status, "utf8")).toBe("refuse.pi.filter");
  });
  it("T-PI-FILTER-PASSTHROUGH", () => {
    const { root, status, child } = run("passthrough");
    expect(child.status).toBe(0);
    expect(existsSync(status)).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "accepted.json"), "utf8")).content)
      .toEqual([{ type: "text", text: "ordinary.txt" }]);
  });
  it("T-PI-FILTER-OPEN-TIP", () => {
    const { root, status, child } = run("partial", "open");
    expect(child.status).toBe(0);
    expect(existsSync(status)).toBe(false);
    expect(readFileSync(join(root, "accepted.json"), "utf8")).toBe(JSON.stringify({
      content: [{ type: "text", text: "ordinary.txt\n[1 entries withheld: sensitive files]" }],
      structuredContent: "ordinary.txt\n[1 entries withheld: sensitive files]",
    }));
  });
});
