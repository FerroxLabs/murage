// The Mac release step that staples, re-zips and rebuilds the feed, run for
// real with stub tools on PATH. One dropped stapler connection used to fail the
// whole release build; a stapler that never succeeds must still stop the step
// before any re-zip, blockmap or feed change.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const workflow = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const stapleStep = Object.values(workflow.jobs)
  .flatMap((job) => job.steps ?? [])
  .find((step) => step.name?.startsWith("Staple, re-zip"));

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

function stub(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

function runStep({ failures }) {
  const root = mkdtempSync(join(tmpdir(), "mac-staple-retry-"));
  dirs.push(root);
  const bin = join(root, "bin"), work = join(root, "work"), log = join(root, "calls.log");
  mkdirSync(bin); mkdirSync(join(work, "release", "mac-arm64", "Murage.app"), { recursive: true });
  mkdirSync(join(work, "release", "mac", "Murage.app"), { recursive: true });
  for (const name of ["Murage-9.9.9-arm64.dmg", "Murage-9.9.9-x64.dmg", "Murage-9.9.9-arm64.zip", "Murage-9.9.9-x64.zip"]) {
    writeFileSync(join(work, "release", name), "x");
  }
  // The stapler fails its first `failures` calls, then succeeds.
  stub(bin, "xcrun", `echo "xcrun $*" >> "$CALLS"
n=$(cat "$CALLS.n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$CALLS.n"
[ "$n" -gt "$FAILURES" ]`);
  stub(bin, "sleep", `echo "sleep $*" >> "$CALLS"`);
  stub(bin, "ditto", `echo "ditto $*" >> "$CALLS"`);
  stub(bin, "node", `echo "node $*" >> "$CALLS"; [ "$1" = "-p" ] && echo 9.9.9; exit 0`);
  writeFileSync(join(root, "step.sh"), stapleStep.run);
  // GitHub runs a Mac `run:` block as `bash -e {0}`.
  const result = spawnSync("bash", ["-e", join(root, "step.sh")], {
    cwd: work,
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, CALLS: log, FAILURES: String(failures), HOME: root },
  });
  let calls = [];
  try { calls = readFileSync(log, "utf8").trim().split("\n"); } catch { /* no calls */ }
  return { status: result.status, out: `${result.stdout}${result.stderr}`, calls };
}

describe.skipIf(process.platform === "win32")("Mac release stapling", () => {
  it("the step exists in release.yml", () => {
    expect(stapleStep?.run).toMatch(/xcrun stapler staple/);
  });

  it("a stapler that drops twice is tried again and the release step finishes", () => {
    const { status, calls } = runStep({ failures: 2 });
    expect(status).toBe(0);
    const staples = calls.filter((line) => line.startsWith("xcrun stapler staple"));
    expect(staples.slice(0, 3)).toEqual(Array(3).fill("xcrun stapler staple release/Murage-9.9.9-arm64.dmg"));
    expect(staples).toHaveLength(6);
    expect(calls.filter((line) => line.startsWith("sleep"))).toEqual(["sleep 30", "sleep 30"]);
    expect(calls.filter((line) => line.startsWith("ditto"))).toHaveLength(2);
    expect(calls.some((line) => line.includes("regenerate-mac-feed.mjs"))).toBe(true);
  });

  it("a stapler that fails six times fails the step with no re-zip, blockmap or feed", () => {
    const { status, calls, out } = runStep({ failures: 1_000 });
    expect(status).not.toBe(0);
    expect(calls.filter((line) => line.startsWith("xcrun stapler staple"))).toEqual(
      Array(6).fill("xcrun stapler staple release/Murage-9.9.9-arm64.dmg"),
    );
    expect(calls.filter((line) => line.startsWith("sleep"))).toHaveLength(5);
    expect(calls.some((line) => line.startsWith("ditto") || line.startsWith("node"))).toBe(false);
    expect(out).toMatch(/could not staple release\/Murage-9\.9\.9-arm64\.dmg after 6 tries/);
  });
});
