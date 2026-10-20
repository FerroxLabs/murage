// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MINIMAL_ARGV, fixtureEngineBytes } from "./engine-launch-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const validate = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result=module.validate_request(json.loads(sys.argv[2]),manifest_path=sys.argv[3],manifest_uid=os.getuid(),engine_root=sys.argv[4],cache_root=sys.argv[5])
print(json.dumps({"command":result[3],"env":result[5]}))`;
let root: string, engineRoot: string, home: string, command: string, manifest: string, digest: string;
beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".murage-manifest-")); engineRoot = join(root, "engine-homes"); home = join(engineRoot, "claudeAgent");
  mkdirSync(home, { recursive: true }); mkdirSync(join(root, "bin"));
  command = join(root, "bin", "fixture-cli"); const bytes = fixtureEngineBytes();
  writeFileSync(command, bytes, { mode: 0o755 }); digest = createHash("sha256").update(bytes).digest("hex");
  manifest = join(root, "engine-manifest.json"); writeFileSync(manifest, JSON.stringify({ claudeAgent: [{ path: command, sha256: digest }] }), { mode: 0o644 });
});
afterEach(() => removeTempDirSync(root));
function request(executable = command): { engine: string; bot: string; command: string; args: string[]; cwd: string; env: Record<string, string> } { return { engine: "claudeAgent", bot: "fixture-bot", command: executable, args: MINIMAL_ARGV.claudeAgent, cwd: home, env: { LD_AUDIT: "/fixture/audit.so", LD_DEBUG_OUTPUT: "/fixture/debug", NODE_OPTIONS: "--require /fixture/loader.js", LANG: "C.UTF-8" } }; }
function check(input = request()) { return JSON.parse(execFileSync("python3", ["-I", "-c", validate, launcher, JSON.stringify(input), manifest, engineRoot, join(root, "digest-cache")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
it("validates the exact listed executable digest and strips every LD variable", () => {
  const result = check(); expect(result.command).toBe(command); expect(result.env.LANG).toBe("C.UTF-8");
  expect(Object.keys(result.env).filter(key => key.startsWith("LD_"))).toEqual([]); expect(result.env.NODE_OPTIONS).toBeUndefined();
});
it("refuses an executable inside the writable engine home even if listed", () => {
  const executable = join(home, "rogue"); writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(manifest, JSON.stringify({ claudeAgent: [{ path: executable, sha256: digest }] }));
  expect(() => check(request(executable))).toThrow();
});
it("refuses a listed path with a different digest", () => {
  writeFileSync(manifest, JSON.stringify({ claudeAgent: [{ path: command, sha256: "0".repeat(64) }] }));
  expect(() => check()).toThrow();
});
it("refuses writable manifest or binary inputs", () => {
  chmodSync(manifest, 0o666); expect(() => check()).toThrow();
  chmodSync(manifest, 0o644); chmodSync(command, 0o777); expect(() => check()).toThrow();
});

const loaders = ["LD_PRELOAD", "LD_AUDIT", "BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONINSPECT", "PERL5OPT", "PERL5LIB", "RUBYOPT", "GCONV_PATH"];
it("drops every loader control while preserving this engine's own credential", () => {
  // The environment is an allowlist (engine-env-allowlist.test.ts): Claude's own
  // ANTHROPIC_API_KEY survives, an unknown API_KEY is dropped like every other name.
  const input = request(); Object.assign(input.env, Object.fromEntries(loaders.map(key => [key, "fixture-loader"])), { ANTHROPIC_API_KEY: "fixture-credential", API_KEY: "fixture-unknown" });
  const result = check(input); for (const key of loaders) expect(result.env).not.toHaveProperty(key);
  expect(result.env.ANTHROPIC_API_KEY).toBe("fixture-credential");
  expect(result.env).not.toHaveProperty("API_KEY");
});
it("refuses the original Opus listed bash -c and planted script probes", () => {
  const shell = join(root, "bin", "bash"); copyFileSync("/bin/bash", shell); chmodSync(shell, 0o755);
  writeFileSync(manifest, JSON.stringify({ claudeAgent: [{ path: shell, sha256: createHash("sha256").update(readFileSync(shell)).digest("hex") }] }));
  const planted = join(home, "planted.sh"); writeFileSync(planted, "echo planted\n");
  for (const args of [["-c", "cat ~/.codex/auth.json"], [planted], ["-e", "fixture"], ["--eval=fixture"], ["-"], ["--loader", planted]]) {
    expect(() => check({ ...request(shell), args })).toThrow();
  }
});
it("refuses script executables and future unbound interpreted grants", () => {
  const bytes = "#!/bin/sh\nexit 0\n"; writeFileSync(command, bytes);
  writeFileSync(manifest, JSON.stringify({ claudeAgent: [{ path: command, sha256: createHash("sha256").update(bytes).digest("hex") }] }));
  expect(() => check()).toThrow();
});
it("refuses writable ancestors of a correctly digested binary and manifest", () => {
  chmodSync(join(root, "bin"), 0o777); expect(() => check()).toThrow(); chmodSync(join(root, "bin"), 0o755);
  chmodSync(root, 0o777); expect(() => check()).toThrow(); chmodSync(root, 0o700);
});
it("accepts a trusted filesystem link but refuses its writable lookup ancestor", () => {
  const alias = join(root, "alias"); mkdirSync(alias); symlinkSync(command, join(alias, "native"));
  expect(check(request(join(alias, "native"))).command).toBe(command);
  chmodSync(alias, 0o777); expect(() => check(request(join(alias, "native")))).toThrow();
});

it("validates the native Fuigo and browser manifest entries through actual Python", () => {
  writeFileSync(manifest, JSON.stringify({ fuigoAgent: [{ path: command, sha256: digest }], browser: [{ path: command, sha256: digest }] }));
  const source = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("l",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
print(json.dumps([m.manifest_command(engine,sys.argv[2],sys.argv[3],os.getuid()) for engine in ["fuigoAgent","browser"]]))`;
  expect(JSON.parse(execFileSync("python3", ["-I", "-c", source, launcher, command, manifest], { encoding: "utf8" }))).toEqual([command, command]);
});
it("refuses a foreign-owned ancestor (synthetic stat identity, actual validation)", () => {
  const source = `import importlib.util,os,sys,types
spec=importlib.util.spec_from_file_location("l",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=m.os.lstat
m.os.lstat=lambda path: types.SimpleNamespace(st_uid=os.getuid()+1,st_mode=original(path).st_mode) if path==sys.argv[4] else original(path)
m.manifest_command("claudeAgent",sys.argv[2],sys.argv[3],os.getuid())`;
  expect(() => execFileSync("python3", ["-I", "-c", source, launcher, command, manifest, join(root, "bin")], { stdio: "pipe" })).toThrow();
});

// Digest cache (PC-01). The harness counts full-file hashes and lets each case mutate state between calls.
const cacheHarness = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("l",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
cmd,manifest,cache,uid=os.path.realpath(sys.argv[2]),sys.argv[3],sys.argv[4],os.getuid()
hashed=[0];real=m.hash_stream
def counting(stream):
    hashed[0]+=1;return real(stream)
m.hash_stream=counting
def call(stamps=None):
    return m.manifest_command("browser",cmd,manifest,uid,cache_root=cache,stamps=stamps)
def attempt():
    before=hashed[0]
    try: call();ok=True
    except ValueError as error: ok=str(error)
    return [ok,hashed[0]-before]
`;
function cache(body: string, expected = digest) {
  writeFileSync(manifest, JSON.stringify({ browser: [{ path: command, sha256: expected }] }));
  const source = cacheHarness + body;
  return JSON.parse(execFileSync("python3", ["-I", "-c", source, launcher, command, manifest, join(root, "digest-cache"), expected], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}
it("hashes once, then serves the second call from the digest cache", () => {
  expect(cache("print(json.dumps([attempt(),attempt(),attempt()]))")).toEqual([[true, 1], [true, 0], [true, 0]]);
  const mode = (statSync(join(root, "digest-cache")).mode & 0o777); expect(mode).toBe(0o700);
});
it("re-hashes when mtime, ctime, size or inode change", () => {
  const touched = cache(`attempt()
t=os.stat(cmd);os.utime(cmd,ns=(t.st_atime_ns,t.st_mtime_ns+5_000_000_000))
a=attempt()
import time;time.sleep(0.05)
os.chmod(cmd,0o700);os.chmod(cmd,0o755)
b=attempt()
os.rename(cmd,cmd+".old");open(cmd,"wb").write(open(cmd+".old","rb").read());os.chmod(cmd,0o755)
c=attempt()
print(json.dumps([a,b,c]))`);
  expect(touched.map((item: [boolean, number]) => item[1])).toEqual([1, 1, 1]);
});
it("re-hashes (and refuses) a same-size content change that preserves mtime", () => {
  const out = cache(`attempt()
t=os.stat(cmd);data=bytearray(open(cmd,"rb").read());data[-1]^=1
open(cmd,"wb").write(bytes(data));os.utime(cmd,ns=(t.st_atime_ns,t.st_mtime_ns))
print(json.dumps(attempt()))`);
  expect(out[0]).toContain("digest mismatch"); expect(out[1]).toBe(1);
});
it("ignores a cache directory or entry with wrong mode or owner", () => {
  const out = cache(`attempt()
cache_mode=os.stat(cache).st_mode
os.chmod(cache,0o755);a=attempt()
os.chmod(cache,0o700);b=attempt()
entry=os.path.join(cache,os.listdir(cache)[0]);os.chmod(entry,0o644);c=attempt()
os.chmod(entry,0o600);d=attempt()
st=json.load(open(entry))["stamp"]
e=[m.cached_digest(cache,uid,cmd,st,sys.argv[5]),m.cached_digest(cache,uid+1,cmd,st,sys.argv[5])]
print(json.dumps([a,b,c,d,e]))`);
  // wrong dir mode: hash again; restored: hit; wrong entry mode: hash again (entry is rewritten); restored: hit.
  expect(out[0][1]).toBe(1); expect(out[1][1]).toBe(0); expect(out[2][1]).toBe(1); expect(out[3][1]).toBe(0); expect(out[4]).toEqual([true, false]);
});
it("does not trust a cached digest that disagrees with the manifest", () => {
  const out = cache(`attempt()
entry=os.path.join(cache,os.listdir(cache)[0]);v=json.load(open(entry));v["sha256"]="0"*64
open(entry,"w").write(json.dumps(v));os.chmod(entry,0o600)
a=attempt()
json.dump({"path":cmd,"stamp":v["stamp"],"sha256":"1"*64},open(entry,"w"));b=attempt()
open(entry,"w").write("not json");c=attempt()
print(json.dumps([a,b,c]))`);
  expect(out.map((item: [boolean, number]) => item[1])).toEqual([1, 1, 1]);
  // A listed digest that is wrong is still refused even when a cache entry exists for the real digest.
  expect(cache("print(json.dumps(attempt()))", "0".repeat(64))[0]).toContain("digest mismatch");
});
it("keeps refusals strict on a cache hit and rechecks identity cheaply", () => {
  const out = cache(`stamps={};call(stamps)
m.recheck_stamp(cmd,stamps[cmd],uid)
before=hashed[0]
os.chmod(os.path.dirname(cmd),0o777)
try: call();warm=True
except ValueError: warm=False
os.chmod(os.path.dirname(cmd),0o755)
t=os.stat(cmd);os.utime(cmd,ns=(t.st_atime_ns,t.st_mtime_ns+7))
try: m.recheck_stamp(cmd,stamps[cmd],uid);changed=False
except ValueError: changed=True
print(json.dumps([warm,changed,hashed[0]-before]))`);
  expect(out).toEqual([false, true, 0]);
});
