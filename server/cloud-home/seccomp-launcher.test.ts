// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
it("places --seccomp and --disable-userns before the bwrap -- separator in the real turn argv", () => {
  const out = JSON.parse(execFileSync("python3", ["-I", "-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("l", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
argv, blobs = m.turn_mount_args("codex", [], "/fixture/home", "/fixture/home", "/fixture/cli", ["a"], None)
print(json.dumps(m.with_seccomp(argv, "@fd:seccomp")))`, launcher], { encoding: "utf8" })) as string[];
  const sep = out.indexOf("--");
  expect(out.indexOf("--seccomp")).toBeGreaterThan(0); expect(out.indexOf("--seccomp")).toBeLessThan(sep);
  expect(out[out.indexOf("--seccomp") + 1]).toBe("@fd:seccomp");
  expect(out.indexOf("--disable-userns")).toBeGreaterThan(0); expect(out.indexOf("--disable-userns")).toBeLessThan(sep);
  expect(out.slice(sep + 1).includes("--seccomp")).toBe(false);
});
