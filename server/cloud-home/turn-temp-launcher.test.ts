// SPDX-License-Identifier: AGPL-3.0-or-later
// Claude's --mcp-config file and system prompt are rendered by the launcher into the turn's
// private render directory, /tmp/murage-render-<unit hex>/, inside the turn's own /tmp tmpfs.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const HOME = "/data/engine-homes/claudeAgent";
const plan = () => execFileSync("python3", ["-I", "-c", `
import json, runpy, sys
m = runpy.run_path(sys.argv[1])
home = sys.argv[2]
render = m["validate_render"]("claudeAgent", {"systemPrompt": "x"}, "0123456789abcdef")
argv, blobs = m["turn_mount_args"]("claudeAgent", [], home, home, "claude", [], render, [], (10, 20))
print(json.dumps(argv))
`, launcher, HOME], { encoding: "utf8" });
it("mounts a turn render file inside the turn's private /tmp tmpfs, never under the engine home", () => {
  const argv = JSON.parse(plan()) as string[];
  const path = "/tmp/murage-render-0123456789abcdef/prompt.txt";
  expect(argv).toContain(path);
  const tmpfs = argv.indexOf("--tmpfs");
  expect(argv[tmpfs + 1]).toBe("/tmp");
  expect(tmpfs).toBeLessThan(argv.indexOf(path));
  // The only engine-home tmp path is TMPDIR itself, created inside the turn's $HOME (the launcher's tmpfs, bound at the home path).
  expect(argv.filter(arg => arg.startsWith(HOME + "/tmp"))).toEqual([HOME + "/tmp"]);
  expect(argv[argv.indexOf(HOME + "/tmp") - 1]).toBe("--dir");
  expect(argv.indexOf(HOME)).toBeLessThan(argv.indexOf(HOME + "/tmp"));
  expect(argv[argv.indexOf("/tmp/murage-render-0123456789abcdef") - 1]).toBe("--dir");
});
it("accepts only the exact render file shapes in a turn plan", () => {
  const out = JSON.parse(execFileSync("python3", ["-I", "-c", `
import json, runpy, sys
m = runpy.run_path(sys.argv[1])
paths = ["/tmp/murage-render-0123456789abcdef/mcp.json", "/tmp/murage-render-0123456789abcdef/prompt.txt", "/tmp/evil.json", "/tmp/murage-render-0123456789abcdef/../../etc/x",
         "/tmp/murage-render-0123456789abcdef/other.json", "/tmp/murage-render-xyz/mcp.json", "/tmp/x/murage-render-0123456789abcdef/mcp.json", "/tmp/murage-mcp-0123456789ab/mcp.json"]
print(json.dumps([bool(m["RENDER_PATTERN"].match(p)) for p in paths]))
`, launcher], { encoding: "utf8" }));
  expect(out).toEqual([true, true, false, false, false, false, false, false]);
});
