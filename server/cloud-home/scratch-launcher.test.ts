// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const script = `import importlib.util,json,sys,os
spec=importlib.util.spec_from_file_location("scratch_fixture",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
engine,home,scratch=sys.argv[2],"/fixture/home",json.loads(sys.argv[3])
try:
 argv,blobs=m.turn_mount_args(engine,[],home,home,"/fixture/cli",[],None,scratch)
 print(json.dumps({"argv":argv}))
except ValueError as e:
 print(json.dumps({"error":str(e)}))`;
const run = (engine: string, scratch: unknown) =>
  JSON.parse(execFileSync("python3", ["-I", "-c", script, launcher, engine, JSON.stringify(scratch)], { encoding: "utf8" })) as { argv?: string[]; error?: string };
const ok = "native/provider-turns/fuigoAgent-abcDEF123456";
it("mounts a scratch tmpfs before the file binds that land inside it", () => {
  // A routed Fuigo turn's $FUIGO_HOME is the scratch tmpfs; the launcher renders its tiers there.
  const path = `/fixture/home/${ok}/config.toml`;
  const { argv } = run("fuigoAgent", [ok]);
  const tmpfs = argv!.indexOf(`/fixture/home/${ok}`), bind = argv!.indexOf("--ro-bind-data");
  expect(argv![tmpfs - 1]).toBe("--tmpfs");
  expect(argv![tmpfs - 3]).toBe("--size"); expect(argv![tmpfs - 2]).toBe("536870912");
  expect(argv!.indexOf("--bind")).toBeLessThan(tmpfs);  // the turn home bind precedes every tmpfs inside it
  expect(tmpfs).toBeLessThan(bind);
  expect(argv![bind + 2]).toBe(path);
});
it.each([
  ["parent traversal", ["native/provider-turns/../../x"]],
  ["embedded ..", ["native/provider-turns/fuigoAgent-abcdef/../fuigoAgent-abcdef"]],
  ["absolute", ["/fixture/home/" + ok]],
  ["wrong prefix", ["native/other/fuigoAgent-abcdef"]],
  ["too-short name", ["native/provider-turns/fuigoAgent-abc"]],
  ["too-long name", ["native/provider-turns/fuigoAgent-" + "a".repeat(33)]],
  ["trailing slash", [ok + "/"]],
  ["nested path", [ok + "/sub"]],
  ["other engine's name", ["native/provider-turns/hermesAgent-abcdef"]],
  ["more than two entries", [ok, ok + "1", ok + "2"]],
  ["not a list", ok],
  ["non-string entry", [1]],
])("rejects scratch: %s", (_name, scratch) => {
  expect(run("fuigoAgent", scratch).error).toMatch(/scratch/);
});
it("accepts two entries and none", () => {
  expect(run("fuigoAgent", []).error).toBeUndefined();
  const { argv } = run("fuigoAgent", [ok, ok + "9"]);
  const scratchTmpfs = argv!.flatMap((a, i) => a === "--tmpfs" && argv![i + 1].includes("/native/provider-turns/") && !argv![i + 1].endsWith("/plugins") ? [argv![i + 1]] : []);
  expect(scratchTmpfs).toEqual([`/fixture/home/${ok}`, `/fixture/home/${ok}9`]);
  for (const i of argv!.flatMap((a, j) => a === "--tmpfs" && argv![j + 1].startsWith(`/fixture/home/${ok}`) && !argv![j + 1].endsWith("/plugins") ? [j] : [])) expect(argv![i - 1]).toBe("536870912");
});
it("gives every tmpfs a size cap immediately before it", () => {
  const { argv } = run("fuigoAgent", [ok, ok + "9"]);
  const at = argv!.flatMap((a, i) => a === "--tmpfs" ? [i] : []);
  expect(at.length).toBeGreaterThan(3);
  for (const i of at) { expect(argv![i - 2]).toBe("--size"); expect(argv![i - 1]).toMatch(/^[1-9]\d+$/); }
  expect(argv![at[0] - 1]).toBe("536870912"); expect(argv![at[0] + 1]).toBe("/tmp");
});
