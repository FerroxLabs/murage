// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const nft = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/murage-egress.nft", import.meta.url)), "utf8");
const py = (body: string) => JSON.parse(execFileSync("python3", ["-I", "-c", `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("l", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}`, launcher], { encoding: "utf8" }));
const SEP = "--";
it("builds a pasta spawn argv with only the 8799 loopback forward, no host mapping and the DNS forward", () => {
  const a = py(`print(json.dumps(m.pasta_argv("/run/murage-turn/t-0123456789abcdef")))`) as string[];
  const sep = a.indexOf(SEP);
  expect(a[0]).toBe("/usr/bin/pasta");
  expect(a.slice(sep + 1)).toEqual(["/usr/bin/python3", "-I", "/usr/local/libexec/murage-turn-launch", "--pasta-child", "/run/murage-turn/t-0123456789abcdef"]);
  const opts = a.slice(0, sep);
  expect(opts).toContain("--no-map-gw"); expect(opts).toContain("--config-net");
  expect(opts.some((x) => /map-host-loopback|map-guest-addr|--foreground/.test(x))).toBe(false);
  expect(opts.filter((x) => x === "-T").length).toBe(1); expect(opts[opts.indexOf("-T") + 1]).toBe("8799");
  for (const f of ["-t", "-u", "-U"]) expect(opts[opts.indexOf(f) + 1]).toBe("none");
  expect(opts).not.toContain("-D");
  expect(opts[opts.indexOf("--dns-forward") + 1]).toBe("192.0.2.53");
  expect(opts.filter((x) => x === "-T" || x === "-t" || x === "-u" || x === "-U").length).toBe(4);
});
it("stages config and resolv.conf as @fd: tokens, with seccomp and binds before bwrap's --", () => {
  const r = py(`
argv, blobs = m.turn_mount_args("codex", [], "/fixture/home", "/fixture/home", "/fixture/cli", ["a"], None)
out = m.with_seccomp(argv, "@fd:seccomp")
print(json.dumps({"argv": out, "blobs": blobs}))`);
  const a = r.argv as string[]; const sep = a.indexOf("--");
  for (const f of ["--seccomp", "--disable-userns"]) { expect(a.indexOf(f)).toBeGreaterThan(0); expect(a.indexOf(f)).toBeLessThan(sep); }
  expect(a[a.indexOf("--seccomp") + 1]).toBe("@fd:seccomp");
  expect(a.slice(sep + 1).some((x) => x.startsWith("--unshare") || x === "--seccomp")).toBe(false);
  expect(a.some((x) => ["--unshare-net", "--info-fd", "--block-fd"].includes(x))).toBe(false);
  const i = a.indexOf("/etc/resolv.conf");
  expect(a[i - 2]).toBe("--ro-bind-data"); expect(a[i - 1]).toBe("@fd:resolv");
  expect(a.filter((x) => x === "/etc/resolv.conf").length).toBe(1);
  expect(r.blobs.resolv).toBe("nameserver 192.0.2.53\n");
  expect(r.blobs.f0).toBe("check_for_update_on_startup = false\n");
});
const child = (body: string) => py(`
import tempfile
root = os.path.realpath(tempfile.mkdtemp())  # the plan directory must be its real path; macOS temp sits behind /var -> /private/var
os.getuid = lambda: 424242; os.geteuid = lambda: 424242
route_ok = os.path.join(root, "route"); open(route_ok, "w").write("Iface\\tDestination\\tGateway\\tFlags\\tRefCnt\\tUse\\tMetric\\tMask\\nnet0\\t00000000\\t0100000A\\t0003\\t0\\t0\\t0\\t00000000\\n")
route_none = os.path.join(root, "none"); open(route_none, "w").write("Iface\\tDestination\\tGateway\\tFlags\\tRefCnt\\tUse\\tMetric\\tMask\\nlo\\t0000007F\\t00000000\\t0001\\t0\\t0\\t0\\t000000FF\\n")
empty6 = os.path.join(root, "r6"); open(empty6, "w").write("")
TURN = 424242
umap = os.path.join(root, "uid_map"); open(umap, "w").write("         0     424242          1\\n")
calls = []
class Exec(BaseException): pass
def fake_execv(*a):
    calls.append(a); raise Exec()
def attempt(directory, route=route_ok, troot=root, uid_map=None):
    try:
        m.pasta_child(directory, troot, route, empty6, fake_execv, uid_map or umap, TURN)
    except Exec:
        return "exec"
    except Exception as e:
        return "refused:" + str(e)
def make(argv=None, name="t-0123456789abcdef", blobs=None):
    argv = argv or ["/usr/bin/bwrap", "--ro-bind-data", "@fd:f0", "/data/engine-homes/codex/.codex/config.toml", "--seccomp", "@fd:seccomp", "--", "/cmd", "@fd:f0"]
    return m.write_turn_dir(argv, blobs or {"f0": "cfg", "seccomp": b"12345678"}, None, root, name)
${body}`);
it("pasta child substitutes real fds for --ro-bind-data and --seccomp before bwrap's --, leaving command args alone", () => {
  const r = child(`
d = make()
res = attempt(d)
argv = calls[0][1]
print(json.dumps({"res": res, "exe": calls[0][0], "argv": argv, "inh": [os.get_inheritable(int(x)) for x in argv if x.isdigit()],
 "data": [os.pread(int(x), 100, 0).decode("latin1") for x in argv if x.isdigit()]}))`);
  expect(r.res).toBe("exec"); expect(r.exe).toBe("/usr/bin/bwrap");
  const a = r.argv as string[]; const sep = a.indexOf("--");
  expect(a[a.indexOf("--ro-bind-data") + 1]).toMatch(/^\d+$/); expect(a.indexOf("--ro-bind-data")).toBeLessThan(sep);
  expect(a[a.indexOf("--seccomp") + 1]).toMatch(/^\d+$/); expect(a.indexOf("--seccomp")).toBeLessThan(sep);
  expect(a.slice(sep)).toEqual(["--", "/cmd", "@fd:f0"]);
  expect(r.inh).toEqual([true, true]); expect(r.data).toEqual(["cfg", "12345678"]);
});
it("pasta child refuses, before any exec, without a default route or with a bad plan or directory", () => {
  const r = child(`
out = {}
d = make(); out["noroute"] = attempt(d, route_none)
out["outside"] = attempt(d, route_ok, "/run/other")
out["badname"] = attempt(make(name="t-evil"))
os.mkdir(root + "/t-aaaaaaaaaaaaaaaa"); out["noplan"] = attempt(root + "/t-aaaaaaaaaaaaaaaa")
bad = {"notbwrap": ["/bin/sh", "--seccomp", "@fd:seccomp", "--", "x"],
 "noseccomp": ["/usr/bin/bwrap", "--", "x"],
 "badpath": ["/usr/bin/bwrap", "--ro-bind-data", "@fd:f0", "/etc/shadow", "--seccomp", "@fd:seccomp", "--", "x"],
 "unknowntoken": ["/usr/bin/bwrap", "--seccomp", "@fd:other", "--", "x"],
 "netns": ["/usr/bin/bwrap", "--unshare-net", "--seccomp", "@fd:seccomp", "--", "x"],
 "nosep": ["/usr/bin/bwrap", "--seccomp", "@fd:seccomp"]}
for i, (k, argv) in enumerate(bad.items()):
    out[k] = attempt(make(argv, "t-%016x" % i))
other = os.path.join(root, "other"); open(other, "w").write("0 424243 1\\n")
out["otheruser"] = attempt(d, uid_map=other)
os.getuid = lambda: os.stat(d).st_uid
out["turnowned"] = attempt(d)
os.getuid = lambda: 424242
full = os.path.join(root, "full"); open(full, "w").write("0 0 4294967295\\n")
out["root"] = attempt(d, uid_map=full)
print(json.dumps({"out": out, "calls": len(calls)}))`);
  expect(r.calls).toBe(0);
  for (const [k, v] of Object.entries(r.out as Record<string, string>)) expect([k, v.startsWith("refused:")]).toEqual([k, true]);
});
it("writes per-turn files 0640 inside a 0750 directory", () => {
  const r = child(`
d = make()
print(json.dumps({"dir": oct(os.stat(d).st_mode & 0o7777), "files": {f: oct(os.stat(d + "/" + f).st_mode & 0o7777) for f in sorted(os.listdir(d))}, "plan": json.load(open(d + "/plan.json"))["files"]}))`);
  expect(r.dir).toBe("0o750");
  expect(r.files).toEqual({ f0: "0o640", "plan.json": "0o640", seccomp: "0o640" });
  expect(r.plan).toEqual(["f0", "seccomp"]);
});
it("launch() has no run_in_netns, memfd or info/block fd plumbing and execs pasta after dropping privileges", () => {
  const src = readFileSync(launcher, "utf8");
  for (const gone of ["run_in_netns", "read_child_pid", "with_netns", "PASTA_READY_SECONDS", "memfd_create", "subprocess"]) expect(src).not.toContain(gone);
  expect(src.indexOf("os.setuid(account.pw_uid)")).toBeLessThan(src.indexOf("os.execve(PASTA, pasta_argv(turn_dir), env)"));
});
it("has a default-drop input chain with an empty ssh allowlist and no host-loopback widening", () => {
  expect(nft).toMatch(/chain input \{\s*type filter hook input priority filter; policy drop;/);
  expect(nft).toMatch(/set qual_ssh \{ type ipv4_addr; flags interval; \}/);
  expect(nft).toMatch(/set qual_ssh_v6 \{ type ipv6_addr; flags interval; \}/);
  expect(nft).toMatch(/tcp dport 22 ip saddr @qual_ssh counter accept/);
  expect(nft).not.toMatch(/tcp dport \{[^}]*\b22\b/);
});
