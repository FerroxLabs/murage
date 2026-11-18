// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, mkdtempSync, readFileSync, renameSync, statSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudHomeCopy } from "./copy.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { vpsContainerMcpArgs, vpsContainerName, vpsDockerArgs, vpsSshTunnelArgs } from "../vps-computer.ts";
import {
  OWN_SERVER_ALIAS, confirmHostKey, isPrivateDockerIpv4, ensureKey, handleOwnServerApi, hostKeyConfirmed, isPublicAddress, ownServerAlias,
  ownServerChildEnv, parseKeyscan, readConnection, removeConnection, readPinnedAddress, refreshOwnServerFiles, rescanNeeded, renderSshConfig, saveConnection, scanHostKey,
  testConnection, validateConnection, validateHost, validatePort, validateUser, type OwnServerDeps, type OwnServerRunner,
} from "./own-server.ts";

const BLOB = Buffer.from("fake-ed25519-host-key-bytes").toString("base64");
const FINGERPRINT = `SHA256:${createHash("sha256").update(Buffer.from(BLOB, "base64")).digest("base64").replace(/=+$/, "")}`;

let dir = "";
let calls: Array<{ file: string; args: string[] }> = [];
let behave: (file: string, args: string[]) => { stdout?: string; stderr?: string; fail?: boolean } = () => ({});

const run: OwnServerRunner = async (file, args) => {
  calls.push({ file, args });
  if (file === "ssh-keygen") {
    const out = args[args.indexOf("-f") + 1]!;
    writeFileSync(out, "PRIVATE", { mode: 0o644 });
    writeFileSync(`${out}.pub`, "ssh-ed25519 AAAAFAKE murage-cloud-home\n");
    return { stdout: "", stderr: "" };
  }
  const r = behave(file, args);
  if (r.fail) throw Object.assign(new Error("Command failed"), { stderr: r.stderr ?? "" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
let sshOverride: string | undefined;
const deps = (): OwnServerDeps => ({ dataDir: dir, sshPath: sshOverride, run, resolve: async () => ["93.184.216.34"] });
const DOCKER_ARGV: string[][] = [
  ["-o ConnectTimeout=30", "-T", "-l", "deploy", "-p", "2222", "--", "murage-own-server", "docker", "system", "dial-stdio"],
  ["-o ConnectTimeout=30", "-T", "--", "murage-own-server", "docker", "system", "dial-stdio"],
];
const conn = { host: "server.example.com", port: 2222, user: "deploy" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murage-own-server-"));
  sshOverride = undefined;
  calls = [];
  behave = (file) => (file === "ssh-keyscan" ? { stdout: `# server.example.com:2222 SSH-2.0-OpenSSH\n[server.example.com]:2222 ssh-ed25519 ${BLOB}\n` } : {});
});
afterEach(() => removeTempDirSync(dir));

describe("validation", () => {
  it("accepts public names and addresses", () => {
    expect(validateHost("Server.Example.com")).toBe("server.example.com");
    expect(validateHost("93.184.216.34")).toBe("93.184.216.34");
    expect(validateHost("2606:4700:4700::1111")).toBe("2606:4700:4700::1111");
  });
  it("refuses private, loopback, link-local, CGNAT and odd hosts", () => {
    for (const bad of ["10.0.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "192.168.1.1", "172.16.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "localhost", "box.local", "2130706433", "1.2.3", "fe80::1%eth0"]) {
      expect(() => validateHost(bad), bad).toThrow();
    }
    for (const bad of ["-oProxyCommand=x", "a b.com", "a/b.com", "a;b.com", "a$(x).com", "a\nb.com", "a.com\nHost x", "[::1]", "a#b.com", "", "x".repeat(300)]) {
      expect(() => validateHost(bad), JSON.stringify(bad)).toThrow();
    }
    for (const bad of ["2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2002:808:808::1", "2001:db8::1"]) expect(isPublicAddress(bad), bad).toBe(false);
    for (const bad of ["0.1.2.3", "10.9.9.9", "100.127.0.1", "127.1.1.1", "169.254.9.9", "172.31.0.1", "192.0.0.5", "192.0.2.5", "192.168.9.9", "198.19.0.1", "198.51.100.7", "203.0.113.7", "224.0.0.1", "240.0.0.1", "255.255.255.255"]) expect(isPublicAddress(bad), bad).toBe(false);
    for (const bad of ["a.b.localhost", "x.example.internal", "nas.home.arpa", "box.lan", "x.corp"]) expect(() => validateHost(bad), bad).toThrow(cloudHomeCopy.ownServerHostNotPublic);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
  });
  it("checks user and port", () => {
    expect(validateUser("deploy_1")).toBe("deploy_1");
    for (const bad of ["Root", "1abc", "a b", "", "a".repeat(33), "-x", "a;b"]) expect(() => validateUser(bad), bad).toThrow();
    expect(validatePort(undefined)).toBe(22);
    expect(validatePort("2222")).toBe(2222);
    for (const bad of [0, 65536, 1.5, "x", -1, "22 "]) expect(() => validatePort(bad), String(bad)).toThrow();
    expect(validateConnection({ host: "a.example.com", user: "me" })).toEqual({ host: "a.example.com", port: 22, user: "me" });
  });
});

describe("key and config", () => {
  it("creates the key once with argv only and owner-only modes", async () => {
    const first = await ensureKey(deps());
    const second = await ensureKey(deps());
    expect(first).toBe("ssh-ed25519 AAAAFAKE murage-cloud-home");
    expect(second).toBe(first);
    expect(calls.filter((c) => c.file === "ssh-keygen")).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["-q", "-t", "ed25519", "-N", "", "-C", "murage-cloud-home", "-f", join(dir, "own-server", "id_ed25519")]);
    expect(statSync(join(dir, "own-server")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "own-server", "id_ed25519")).mode & 0o777).toBe(0o600);
  });
  it("writes exactly one Host block", () => {
    saveConnection(conn, deps());
    const text = readFileSync(join(dir, "own-server", "config"), "utf8");
    expect(text.match(/^Host /gm)).toEqual(["Host "]);
    expect(text).toBe(renderSshConfig(conn, deps()));
    for (const line of [`Host ${OWN_SERVER_ALIAS}`, "HostKeyAlias server.example.com", "CheckHostIP no", "ClearAllForwardings yes", "Port 2222", "User deploy", "IdentitiesOnly yes", "StrictHostKeyChecking yes", "BatchMode yes", "ForwardAgent no", "ForwardX11 no"]) expect(text).toContain(line);
    expect(text).toContain(`IdentityFile ${join(dir, "own-server", "id_ed25519")}`);
    expect(text).toContain(`UserKnownHostsFile ${join(dir, "own-server", "known_hosts")}`);
    expect(text).not.toContain("HostName");
    expect(readConnection(deps())).toEqual(conn);
  });
  it("renders the pinned address as HostName after confirm, and an IP literal as itself", async () => {
    saveConnection(conn, deps());
    confirmHostKey(await scanHostKey(deps()), deps());
    const text = readFileSync(join(dir, "own-server", "config"), "utf8");
    expect(text).toContain("  HostName 93.184.216.34\n");
    expect(text).not.toContain("HostName server.example.com");
    expect(readPinnedAddress(deps())).toBe("93.184.216.34");
    saveConnection({ ...conn, user: "other" }, deps());
    expect(readFileSync(join(dir, "own-server", "config"), "utf8")).toContain("HostName 93.184.216.34");
    saveConnection({ host: "8.8.8.8", port: 22, user: "me" }, deps());
    expect(readPinnedAddress(deps())).toBeNull();
    expect(readFileSync(join(dir, "own-server", "config"), "utf8")).toContain("HostName 8.8.8.8");
  });
});

describe("host key", () => {
  it("scans, then writes known_hosts only for the matching fingerprint", async () => {
    saveConnection(conn, deps());
    const fingerprint = await scanHostKey(deps());
    expect(fingerprint).toBe(FINGERPRINT);
    expect(calls.find((c) => c.file === "ssh-keyscan")!.args).toEqual(["-T", "10", "-p", "2222", "-t", "ed25519", "93.184.216.34"]);
    expect(() => confirmHostKey("SHA256:wrong", deps())).toThrow();
    expect(hostKeyConfirmed(deps())).toBe(false);
    confirmHostKey(fingerprint, deps());
    expect(readFileSync(join(dir, "own-server", "known_hosts"), "utf8")).toBe(`server.example.com ssh-ed25519 ${BLOB}\n`);
    expect(statSync(join(dir, "own-server", "known_hosts")).mode & 0o777).toBe(0o600);
    expect(ownServerAlias(deps(), true)).toBe(OWN_SERVER_ALIAS);
    expect(ownServerAlias(deps(), false)).toBeNull();
  });
  it("refuses to confirm without a scan and ignores non-ed25519 lines", async () => {
    saveConnection(conn, deps());
    expect(() => confirmHostKey(FINGERPRINT, deps())).toThrow(cloudHomeCopy.ownServerNoScanPending);
    expect(parseKeyscan("host ssh-rsa AAAA\n", conn)).toBeNull();
  });
  it("uses a bare host for port 22", () => {
    expect(parseKeyscan(`h.example.com ssh-ed25519 ${BLOB}`, { host: "h.example.com", port: 22, user: "u" })!.line).toBe(`h.example.com ssh-ed25519 ${BLOB}\n`);
  });
  it("refuses a name that resolves to a private address", async () => {
    saveConnection(conn, deps());
    await expect(scanHostKey({ ...deps(), resolve: async () => ["10.0.0.5"] })).rejects.toThrow(cloudHomeCopy.ownServerHostNotPublic);
    expect(calls.some((c) => c.file === "ssh-keyscan")).toBe(false);
  });
  it("scans the pinned literal even if the name would resolve differently next time (rebinding)", async () => {
    saveConnection(conn, deps());
    let n = 0;
    const resolve = async () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
    await scanHostKey({ ...deps(), resolve });
    expect(n).toBe(1);
    expect(calls.find((c) => c.file === "ssh-keyscan")!.args.at(-1)).toBe("93.184.216.34");
    expect(calls.some((c) => c.args.includes("server.example.com"))).toBe(false);
  });
  it("prefers an IPv4 answer and refuses when any answer is private", async () => {
    saveConnection(conn, deps());
    await scanHostKey({ ...deps(), resolve: async () => ["2606:4700:4700::1111", "93.184.216.34"] });
    expect(calls.find((c) => c.file === "ssh-keyscan")!.args.at(-1)).toBe("93.184.216.34");
    calls = [];
    await expect(scanHostKey({ ...deps(), resolve: async () => ["93.184.216.34", "10.0.0.5"] })).rejects.toThrow(cloudHomeCopy.ownServerHostNotPublic);
    expect(calls).toHaveLength(0);
  });
  it("changing host or port clears known_hosts, same host keeps it", async () => {
    saveConnection(conn, deps());
    confirmHostKey(await scanHostKey(deps()), deps());
    saveConnection({ ...conn, user: "other" }, deps());
    expect(hostKeyConfirmed(deps())).toBe(true);
    saveConnection({ ...conn, port: 22 }, deps());
    expect(hostKeyConfirmed(deps())).toBe(false);
  });
});

describe("upgrade from an unpinned host key", () => {
  it("reports a rescan instead of connecting by name, and a rescan repairs it", async () => {
    saveConnection(conn, deps());
    writeFileSync(join(dir, "own-server", "known_hosts"), `[server.example.com]:2222 ssh-ed25519 ${BLOB}\n`);
    expect(hostKeyConfirmed(deps())).toBe(false);
    expect(rescanNeeded(deps())).toBe(true);
    expect(ownServerAlias(deps(), true)).toBeNull();
    expect(readFileSync(join(dir, "own-server", "config"), "utf8")).not.toContain("HostName");
    expect(await testConnection(deps())).toEqual({ ok: false, problem: cloudHomeCopy.ownServerRescanNeeded });
    expect(calls.some((c) => c.file === "docker")).toBe(false);
    const answer = await handleOwnServerApi({ method: "PUT", path: "/api/cloud/own-server", readBody: async () => conn, setAlias: () => null, deps: deps() });
    expect(answer!.body).toMatchObject({ rescanNeeded: true, hostKeyConfirmed: false, fingerprint: FINGERPRINT });
    confirmHostKey(FINGERPRINT, deps());
    expect(rescanNeeded(deps())).toBe(false);
    expect(hostKeyConfirmed(deps())).toBe(true);
    expect(readFileSync(join(dir, "own-server", "config"), "utf8")).toContain("HostName 93.184.216.34");
    expect(cloudHomeCopy.ownServerRescanNeeded).not.toMatch(/[\u2013\u2014]|safe/i);
  });
});

describe("test and remove", () => {
  async function ready() {
    saveConnection(conn, deps());
    confirmHostKey(await scanHostKey(deps()), deps());
  }
  it("reports ok with the Docker version", async () => {
    await ready();
    behave = () => ({ stdout: "27.5.1\n" });
    expect(await testConnection(deps())).toEqual({ ok: true, dockerVersion: "27.5.1" });
    expect(calls.at(-1)).toEqual({ file: "docker", args: ["-H", "ssh://murage-own-server", "version", "--format", "{{.Server.Version}}"] });
  });
  it("turns failures into plain problems", async () => {
    await ready();
    const cases: Array<[string, string]> = [
      ["ssh: connect to host x port 22: Connection refused", cloudHomeCopy.ownServerTestUnreachable],
      ["deploy@x: Permission denied (publickey).", cloudHomeCopy.ownServerTestKeyNotInstalled],
      ["bash: docker: command not found", cloudHomeCopy.ownServerTestNoDocker],
      ["permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock", cloudHomeCopy.ownServerTestNoDocker],
      ["Host key verification failed.", cloudHomeCopy.ownServerTestHostKeyChanged],
    ];
    for (const [stderr, problem] of cases) {
      behave = () => ({ fail: true, stderr });
      expect(await testConnection(deps())).toEqual({ ok: false, problem });
    }
  });
  it("needs a confirmed host key", async () => {
    saveConnection(conn, deps());
    expect(await testConnection(deps())).toEqual({ ok: false, problem: cloudHomeCopy.ownServerNotConfirmed });
  });
  it("remove deletes the connection and host key but keeps the key", async () => {
    await ensureKey(deps());
    await ready();
    removeConnection(deps());
    expect(readConnection(deps())).toBeNull();
    expect(hostKeyConfirmed(deps())).toBe(false);
    expect(existsSync(join(dir, "own-server", "config"))).toBe(false);
    expect(existsSync(join(dir, "own-server", "id_ed25519"))).toBe(true);
  });
  it("remove refuses first: a fault after the pin goes leaves a refusing wrapper and no pin", async () => {
    await ready();
    // a non-empty directory where known_hosts should be makes the later trust-file removal fail, as a crash would
    const hosts = join(dir, "own-server", "known_hosts");
    rmSync(hosts, { force: true });
    mkdirSync(hosts);
    writeFileSync(join(hosts, "x"), "x");
    expect(() => removeConnection(deps())).toThrow();
    expect(readPinnedAddress(deps())).toBeNull();
    expect(existsSync(wrapperPath())).toBe(true);
    expect(wrapperExit()).toBe(255);
    expect(hostKeyConfirmed(deps())).toBe(false);
  });
  it("remove closes trust before it touches any other file", async () => {
    await ready();
    let seen = 0;
    // the refusing wrapper is the first write of a remove; when it fails the pin and the wrapper directory are still gone
    expect(() => removeConnection(failing(() => ++seen === 1))).not.toThrow();
    expect(seen).toBe(1);
    expect(readPinnedAddress(deps())).toBeNull();
    expect(existsSync(wrapperPath())).toBe(false);
  });
});

/** A confirmed home whose wrapper execs the script in `realDir` (a test hook) instead of /usr/bin/ssh. */
async function confirmedHome(realDir: string) {
  sshOverride = join(realDir, "ssh");
  saveConnection(conn, deps());
  confirmHostKey(await scanHostKey(deps()), deps());
  return join(dir, "own-server", "bin", "ssh");
}
const sh = (wrapper: string, pathDir: string, ...args: string[]) => spawnSync("/bin/sh", [wrapper, ...args], { env: { PATH: pathDir }, encoding: "utf8" });
function fakeSsh(body: string): string {
  const fake = join(dir, "fakebin");
  mkdirSync(fake);
  writeFileSync(join(fake, "ssh"), body, { mode: 0o755 });
  return fake;
}

describe("child environment", () => {
  it("puts the ssh wrapper first on PATH only on a home with a connection", async () => {
    const env = { PATH: "/usr/bin", HOME: "/h" };
    expect(ownServerChildEnv(env, deps(), true)).toBe(env);
    saveConnection(conn, deps());
    expect(ownServerChildEnv(env, deps(), false)).toBe(env);
    const out = ownServerChildEnv(env, deps(), true);
    expect(out.PATH).toBe(`${join(dir, "own-server", "bin")}:${join(dir, "own-server", "refuse-bin")}:/usr/bin`);
    confirmHostKey(await scanHostKey(deps()), deps());
    const wrapper = readFileSync(join(dir, "own-server", "bin", "ssh"), "utf8");
    expect(wrapper).toContain("exec '/usr/bin/ssh' -F /dev/null -o 'HostName=93.184.216.34'");
    expect(wrapper).toContain("-o 'StrictHostKeyChecking=yes'");
    expect(wrapper).not.toContain(join(dir, "own-server", "config"));
    expect(statSync(join(dir, "own-server", "bin", "ssh")).mode & 0o111).not.toBe(0);
  });
  it("the wrapper refuses agent-supplied ssh options and rebuilds argv for docker's own arguments", async () => {
    const fake = fakeSsh("#!/bin/sh\nfor a in \"$@\"; do echo \"ARG:$a\"; done\n");
    const wrapper = await confirmedHome(fake);
    const go = (...args: string[]) => sh(wrapper, fake, ...args);
    const A = OWN_SERVER_ALIAS;
    for (const bad of [["-oProxyCommand=x", A], ["-o", "ProxyCommand=x", A], ["-o", "ConnectTimeout=3x", A], ["-o ConnectTimeout=30; x", A], ["-L8080:a:80", A], ["-R", "1:a:2", A], ["-D1080", A], ["-W", "a:1", A],
      ["-J", "h", A], ["-F", "/x", A], ["-i", "/k", A], ["-T", "-l", "u", "-oX=y", "--", A, "docker"], ["-l", "-x", A], ["-p", "22a", A],
      ["other.example.com", "docker"], ["--", "other.example.com", "docker"], ["-T"], ["-l"], []]) {
      const r = go(...bad);
      expect(r.status, bad.join(" ")).toBe(255);
      expect(r.stdout).toBe("");
    }
    // docker/cli 27.5.1, recorded with a fake ssh on PATH (docker -H ssh://deploy@host:2222 and ssh://host)
    // the ssh argv is fixed options, then only -T and ConnectTimeout (the -l and -p values are dropped: user and port are baked in), then "--"
    const out = (r: { stdout: string }) => r.stdout.trim().split("\n").map((l) => l.slice(4));
    const tail = (args: string[]) => args.slice(args.indexOf("ControlPath=none") + 1);
    const want = (real: string[]) => [...(real.includes("-T") ? ["-T"] : []), ...(real.some((a) => a.includes("ConnectTimeout=30")) ? ["-o", "ConnectTimeout=30"] : []), "--", ...real.slice(real.indexOf("--") + 1)];
    for (const real of DOCKER_ARGV) {
      const r = go(...real);
      expect(r.status, real.join(" ")).toBe(0);
      expect(out(r).slice(0, 2)).toEqual(["-F", "/dev/null"]);
      expect(out(r)).toEqual(expect.arrayContaining(["Port=2222", "User=deploy", "StrictHostKeyChecking=yes", "HostKeyAlias=server.example.com", "HostName=93.184.216.34"]));
      expect(tail(out(r))).toEqual(want(real));
    }
    // options after the host are the remote command, never ssh options
    const inj = go(A, "-oProxyCommand=id", "-oHostName=evil");
    expect(inj.status).toBe(0);
    expect(tail(out(inj))).toEqual(["--", A, "-oProxyCommand=id", "-oHostName=evil"]);
    expect(go("-o", "ConnectTimeout=30", "-T", "--", A, "docker", "-x", "--rm").status).toBe(0);
    expect(go("-oConnectTimeout=5", "-T", A, "docker", "-x", "--rm").status).toBe(0);
  });
  const realSsh = spawnSync("sh", ["-c", "command -v ssh"], { encoding: "utf8" }).stdout.trim();
  it.skipIf(!realSsh)("with the real ssh -G, injected options after the host take no effect", async () => {
    const fake = fakeSsh(`#!/bin/sh\nexec ${realSsh} -G "$@"\n`);
    const wrapper = await confirmedHome(fake);
    const A = OWN_SERVER_ALIAS;
    const g = (...args: string[]) => {
      const r = sh(wrapper, fake, ...args);
      expect(r.status, r.stderr).toBe(0);
      return Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)]));
    };
    const base = g(A, "docker", "system", "dial-stdio");
    expect(base.hostname).toBe("93.184.216.34");
    expect(base.port).toBe("2222");
    expect(base.user).toBe("deploy");
    expect(base.proxycommand).toBeUndefined();
    const injected = g(A, "-oProxyCommand=id", "-oHostName=evil.example.com", "-oPort=1", "-L8080:x:80", "docker", "system", "dial-stdio");
    expect(injected).toEqual(base);
    expect(base.stricthostkeychecking).toBe("true");
    expect(base.userknownhostsfile).toBe(join(dir, "own-server", "known_hosts"));
    expect(base.globalknownhostsfile).toBe("/dev/null");
    expect(base.controlmaster).toBe("false");
    for (const real of DOCKER_ARGV) {
      const out = g(...real);
      expect(out.hostname).toBe("93.184.216.34");
      expect(out.connecttimeout).toBe("30");
      expect(out.clearallforwardings).toBe("yes");
      expect(out.proxycommand).toBeUndefined();
      expect(out.hostkeyalias).toBe("server.example.com");
    }
    expect(g("-l", "deploy", "-p", "2222", "--", A, "docker").port).toBe("2222");
    expect(g("-l", "other", "-p", "9", "--", A, "docker")).toMatchObject({ user: "deploy", port: "2222" });
  });
  it.skipIf(!realSsh)("config files with Host *, Match all or Include have no effect and known_hosts agrees with HostKeyAlias on a non-22 port", async () => {
    const fake = fakeSsh(`#!/bin/sh\nexec ${realSsh} -G "$@"\n`);
    const wrapper = await confirmedHome(fake);
    const evil = "Host *\n  HostName 127.0.0.1\n  StrictHostKeyChecking no\n  ProxyCommand id\nMatch all\n  HostName 127.0.0.1\n  StrictHostKeyChecking no\n";
    const home = join(dir, "fakehome");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "extra"), evil);
    writeFileSync(join(home, ".ssh", "config"), `Include ${join(home, ".ssh", "extra")}\n${evil}`);
    const config = join(dir, "own-server", "config");
    writeFileSync(config, `${evil}Include ${join(home, ".ssh", "extra")}\n${readFileSync(config, "utf8")}`);
    const r = spawnSync("/bin/sh", [wrapper, OWN_SERVER_ALIAS, "docker"], { env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const field = (name: string) => r.stdout.split("\n").find((l) => l.startsWith(`${name} `))?.slice(name.length + 1);
    console.log(`ssh -G evidence (hostile config + ~/.ssh/config): hostname ${field("hostname")}, stricthostkeychecking ${field("stricthostkeychecking")}, proxycommand ${field("proxycommand")}, port ${field("port")}, hostkeyalias ${field("hostkeyalias")}`);
    expect(field("hostname")).toBe("93.184.216.34");
    expect(field("stricthostkeychecking")).toBe("true");
    expect(field("proxycommand")).toBeUndefined();
    expect(hostKeyConfirmed(deps())).toBe(true);
    // non-22 port: ssh looks the key up under the bare HostKeyAlias, which is exactly the line we write
    const found = spawnSync("ssh-keygen", ["-F", field("hostkeyalias")!, "-f", join(dir, "own-server", "known_hosts")], { encoding: "utf8" });
    expect(found.status, found.stderr).toBe(0);
    expect(found.stdout).toContain("ssh-ed25519");
    expect(field("port")).toBe("2222");
  });
  it("an unconfirmed or unpinned home gets a wrapper that refuses every connection", async () => {
    saveConnection(conn, deps());
    const wrapper = join(dir, "own-server", "bin", "ssh");
    const r = spawnSync("/bin/sh", [wrapper, OWN_SERVER_ALIAS, "docker"], { encoding: "utf8" });
    expect(r.status).toBe(255);
    expect(r.stderr).toContain("not been confirmed");
  });
});

describe("start-up refresh of an older home", () => {
  it("replaces an old wrapper and a by-name config; without a pin nothing connects", async () => {
    const own = join(dir, "own-server");
    mkdirSync(join(own, "bin"), { recursive: true });
    writeFileSync(join(own, "connection.json"), JSON.stringify(conn) + "\n");
    writeFileSync(join(own, "config"), "Host murage-own-server\n  HostName server.example.com\n  Port 2222\n  User deploy\n");
    writeFileSync(join(own, "known_hosts"), `[server.example.com]:2222 ssh-ed25519 ${BLOB}\n`);
    writeFileSync(join(own, "bin", "ssh"), "#!/bin/sh\nexec /usr/bin/ssh -F config \"$@\"\n", { mode: 0o700 });
    refreshOwnServerFiles(deps());
    expect(readFileSync(join(own, "config"), "utf8")).not.toContain("HostName");
    const r = spawnSync("/bin/sh", [join(own, "bin", "ssh"), OWN_SERVER_ALIAS, "docker"], { encoding: "utf8" });
    expect(r.status).toBe(255);
    expect(readFileSync(join(own, "bin", "ssh"), "utf8")).not.toContain("exec /usr/bin/ssh");
    expect(rescanNeeded(deps())).toBe(true);
    // after the owner rescans and confirms, the real wrapper and a pinned config are back
    confirmHostKey(await scanHostKey(deps()), deps());
    refreshOwnServerFiles(deps());
    expect(readFileSync(join(own, "config"), "utf8")).toContain("HostName 93.184.216.34");
    expect(readFileSync(join(own, "bin", "ssh"), "utf8")).toContain("exec ");
  });
  it("removes a stray wrapper when there is no saved connection", () => {
    const own = join(dir, "own-server");
    mkdirSync(join(own, "bin"), { recursive: true });
    writeFileSync(join(own, "bin", "ssh"), "#!/bin/sh\n", { mode: 0o700 });
    refreshOwnServerFiles(deps());
    expect(existsSync(join(own, "bin"))).toBe(false);
  });
});

describe("scan race", () => {
  it("a scan that finishes after the connection changed is rejected and cannot be confirmed", async () => {
    saveConnection(conn, deps());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: OwnServerRunner = async (file, args) => {
      if (file === "ssh-keyscan") await gate;
      return run(file, args, { timeoutMs: 1 });
    };
    const scanA = scanHostKey({ ...deps(), run: slow });
    const other = { host: "other.example.com", port: 22, user: "deploy" };
    saveConnection(other, deps());
    release();
    await expect(scanA).rejects.toThrow(cloudHomeCopy.ownServerNoScanPending);
    expect(() => confirmHostKey(FINGERPRINT, deps())).toThrow(cloudHomeCopy.ownServerNoScanPending);
    expect(hostKeyConfirmed(deps())).toBe(false);
    expect(existsSync(join(dir, "own-server", "pinned-address"))).toBe(false);
    expect(readConnection(deps())).toEqual(other);
  });
  it("a save between scan and confirm invalidates the pending scan", async () => {
    saveConnection(conn, deps());
    const fingerprint = await scanHostKey(deps());
    saveConnection({ ...conn, host: "other.example.com" }, deps());
    expect(() => confirmHostKey(fingerprint, deps())).toThrow(cloudHomeCopy.ownServerNoScanPending);
    expect(hostKeyConfirmed(deps())).toBe(false);
  });
});

describe("routes", () => {
  it("runs the whole flow and keeps vps.sshAlias in step", async () => {
    const aliases: string[] = [];
    const call = (method: string, path: string, body?: unknown) =>
      handleOwnServerApi({ method, path, readBody: async () => body, setAlias: (a) => { aliases.push(a); return null; }, deps: deps() });
    const base = "/api/cloud/own-server";
    const first = await call("GET", base);
    expect(first!.body).toMatchObject({ publicKey: "ssh-ed25519 AAAAFAKE murage-cloud-home", connection: null, hostKeyConfirmed: false });
    expect(JSON.stringify(first!.body)).not.toContain("PRIVATE");
    const put = await call("PUT", base, conn);
    expect(put!.body).toMatchObject({ connection: conn, fingerprint: FINGERPRINT, hostKeyConfirmed: false });
    expect((await call("POST", `${base}/confirm`, { fingerprint: "SHA256:nope" }))!.status).toBe(409);
    expect((await call("POST", `${base}/confirm`, { fingerprint: FINGERPRINT }))!.body).toMatchObject({ hostKeyConfirmed: true });
    expect(aliases.at(-1)).toBe(OWN_SERVER_ALIAS);
    behave = () => ({ stdout: "27.5.1" });
    expect((await call("POST", `${base}/test`))!.body).toMatchObject({ ok: true });
    expect((await call("PUT", base, { host: "10.0.0.1", user: "me" }))!.status).toBe(400);
    expect((await call("DELETE", base))!.body).toMatchObject({ connection: null, hostKeyConfirmed: false });
    expect(aliases.at(-1)).toBe("");
    expect(await call("GET", "/api/other")).toBeNull();
  });
  it("shows a plain problem when the server cannot be scanned", async () => {
    behave = () => ({ fail: true });
    const answer = await handleOwnServerApi({ method: "PUT", path: "/api/cloud/own-server", readBody: async () => conn, setAlias: () => null, deps: deps() });
    expect(answer!.body).toMatchObject({ fingerprint: null, problem: cloudHomeCopy.ownServerScanFailed });
  });
});

const failing = (when: (file: string, count: number) => boolean): OwnServerDeps => ({
  ...deps(),
  beforeWrite: (file, count) => { if (when(file, count)) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); },
});
const wrapperPath = () => join(dir, "own-server", "bin", "ssh");
const wrapperExit = () => spawnSync("/bin/sh", [wrapperPath(), OWN_SERVER_ALIAS, "docker"], { env: { PATH: "/nonexistent" }, encoding: "utf8" }).status;

describe("fail closed when the refresh fails", () => {
  it("hands out no alias and no wrapper PATH entry; PATH keeps every dir and ssh resolves to a refusing shim", async () => {
    const fake = fakeSsh("#!/bin/sh\nexit 0\n");
    await confirmedHome(fake);
    const env = { PATH: `${fake}:/usr/bin`, HOME: "/h" };
    expect(ownServerAlias(deps(), true)).toBe(OWN_SERVER_ALIAS);
    expect(ownServerChildEnv(env, deps(), true).PATH?.split(":")[0]).toBe(join(dir, "own-server", "bin"));
    // the refresh cannot write its files
    expect(refreshOwnServerFiles(failing(() => true))).toBe(false);
    expect(existsSync(join(dir, "own-server", "bin"))).toBe(false);
    expect(ownServerAlias(deps(), true)).toBeNull();
    expect(hostKeyConfirmed(deps())).toBe(false);
    const out = ownServerChildEnv(env, deps(), true);
    expect(out.PATH).not.toContain(join(dir, "own-server", "bin") + ":");
    expect(out.PATH?.split(":")[0]).toBe(join(dir, "own-server", "refuse-bin"));
    expect(out.PATH?.split(":")).toEqual([join(dir, "own-server", "refuse-bin"), fake, "/usr/bin"]);
    const viaPath = spawnSync("sh", ["-c", "command -v ssh; ssh x; echo status=$?; command -v cat"], { env: out, encoding: "utf8" });
    expect(viaPath.stdout).toContain(join(dir, "own-server", "refuse-bin", "ssh"));
    expect(viaPath.stdout).toContain("status=255");
    expect(viaPath.stdout).toMatch(/\/bin\/cat/);
    // a later successful save or confirm switches it back on
    saveConnection(conn, deps());
    confirmHostKey(await scanHostKey(deps()), deps());
    expect(ownServerAlias(deps(), true)).toBe(OWN_SERVER_ALIAS);
  });
  it("refuses when the wrapper is missing, not executable or changed, even though the files agree", async () => {
    const fake = fakeSsh("#!/bin/sh\nexit 0\n");
    const wrapper = await confirmedHome(fake);
    const original = readFileSync(wrapper, "utf8");
    const env = { PATH: `${fake}:/usr/bin` };
    const closed = () => {
      expect(ownServerAlias(deps(), true)).toBeNull();
      const out = ownServerChildEnv(env, deps(), true);
      expect(out.PATH?.split(":")).toEqual([join(dir, "own-server", "refuse-bin"), fake, "/usr/bin"]);
    };
    chmodSync(wrapper, 0o600);
    closed();
    chmodSync(wrapper, 0o700);
    expect(ownServerAlias(deps(), true)).toBe(OWN_SERVER_ALIAS);
    writeFileSync(wrapper, original.replace("exec ", "# exec "), { mode: 0o700 });
    closed();
    writeFileSync(wrapper, "#!/bin/sh\nexec /usr/bin/ssh \"$@\"\n", { mode: 0o700 });
    closed();
    // an identical wrapper that execs another path is not the wrapper the server renders
    writeFileSync(wrapper, original.replace(sshOverride!, "/tmp/x"), { mode: 0o700 });
    closed();
    writeFileSync(wrapper, original, { mode: 0o700 });
    expect(ownServerAlias(deps(), true)).toBe(OWN_SERVER_ALIAS);
    // group or world write
    chmodSync(wrapper, 0o720);
    closed();
    chmodSync(wrapper, 0o700);
    chmodSync(join(dir, "own-server", "bin"), 0o770);
    closed();
    chmodSync(join(dir, "own-server", "bin"), 0o700);
    expect(ownServerAlias(deps(), true)).toBe(OWN_SERVER_ALIAS);
    // a symlinked wrapper, bin dir or own-server dir
    const bin = join(dir, "own-server", "bin");
    renameSync(bin, `${bin}-real`);
    symlinkSync(`${bin}-real`, bin);
    closed();
    rmSync(bin);
    renameSync(`${bin}-real`, bin);
    expect(ownServerAlias(deps(), true)).toBe(OWN_SERVER_ALIAS);
    renameSync(wrapper, `${wrapper}-real`);
    symlinkSync(`${wrapper}-real`, wrapper);
    closed();
    rmSync(wrapper);
    renameSync(`${wrapper}-real`, wrapper);
    expect(ownServerAlias(deps(), true)).toBe(OWN_SERVER_ALIAS);
    removeTempDirSync(join(dir, "own-server", "bin"));
    closed();
  });
});

describe("confirm is all-or-nothing", () => {
  // writes in confirm, in order: refusing wrapper, known_hosts, config, pinned-address, connecting wrapper
  for (const [n, name] of [[1, "refusing wrapper"], [2, "known_hosts"], [3, "config"], [4, "pinned-address"], [5, "connecting wrapper"]] as const) {
    it(`a failed write of the ${name} leaves the home refusing`, async () => {
      saveConnection(conn, deps());
      await scanHostKey(deps());
      const fp = FINGERPRINT;
      let seen = 0;
      const faulty = failing(() => ++seen === n);
      expect(() => confirmHostKey(fp, faulty)).toThrow(/ENOSPC/);
      expect(seen).toBe(n);
      expect(hostKeyConfirmed(deps())).toBe(false);
      expect(ownServerAlias(deps(), true)).toBeNull();
      // when even the refusing wrapper cannot be written the wrapper directory is removed (ssh resolves to the refusing shim)
      if (n === 1) expect(existsSync(wrapperPath())).toBe(false);
      else expect(wrapperExit()).toBe(255);
      // nothing was left half written
      expect(existsSync(join(dir, "own-server", "config.tmp-" + process.pid))).toBe(false);
      // and a fresh scan and confirm repairs it
      confirmHostKey(await scanHostKey(deps()), deps());
      expect(hostKeyConfirmed(deps())).toBe(true);
    });
  }
  it("the wrapper never reads the config: an emptied, truncated or hostile config changes nothing", async () => {
    const fake = fakeSsh("#!/bin/sh\nfor a in \"$@\"; do echo \"ARG:$a\"; done\n");
    const wrapper = await confirmedHome(fake);
    const config = join(dir, "own-server", "config");
    const full = readFileSync(config, "utf8");
    for (const broken of ["", full.split("\n").slice(0, 4).join("\n") + "\n", "Host *\n  HostName 127.0.0.1\n  StrictHostKeyChecking no\n" + full]) {
      writeFileSync(config, broken);
      expect(hostKeyConfirmed(deps())).toBe(true);
      const r = sh(wrapper, fake, OWN_SERVER_ALIAS, "docker");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("ARG:HostName=93.184.216.34");
      expect(r.stdout).not.toContain("127.0.0.1");
    }
  });
  it("a failed save leaves the home refusing", async () => {
    await confirmedHome(fakeSsh("#!/bin/sh\nexit 0\n"));
    // writes in a save: refusing wrapper, connection.json, config, wrapper
    for (const n of [2, 3, 4]) {
      let seen = 0;
      expect(() => saveConnection({ ...conn, port: 2200 + n }, failing(() => ++seen === n))).toThrow(/ENOSPC/);
      expect(hostKeyConfirmed(deps())).toBe(false);
      expect(wrapperExit()).toBe(255);
      saveConnection(conn, deps());
      confirmHostKey(await scanHostKey(deps()), deps());
    }
  });
});

describe("every ssh caller's real argv passes the wrapper", () => {
  const A = OWN_SERVER_ALIAS;
  /** A fake ssh that records its argv, one argument per line, to a file. */
  function recorder(): { fake: string; argv: () => string[] } {
    const rec = join(dir, "argv.txt");
    const fake = fakeSsh(`#!/bin/sh\nfor a in "$@"; do echo "$a"; done > ${rec}\n`);
    return { fake, argv: () => readFileSync(rec, "utf8").split("\n").slice(0, -1) };
  }
  const tail = (a: string[]) => a.slice(a.indexOf("ControlPath=none") + 1);
  const dockerBin = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();

  it("viewer tunnel: vpsSshTunnelArgs runs in tunnel mode with the forward and no ClearAllForwardings", async () => {
    const { fake, argv } = recorder();
    const wrapper = await confirmedHome(fake);
    for (const [port, ip] of [[40123, "172.17.0.2"], [1024, "10.0.0.5"], [65535, "192.168.1.9"], [50000, "172.31.255.254"]] as const) {
      const r = sh(wrapper, fake, ...vpsSshTunnelArgs(A, port, ip));
      expect(r.status, r.stderr).toBe(0);
      const got = argv();
      expect(got.slice(0, 2)).toEqual(["-F", "/dev/null"]);
      expect(got).not.toContain("ClearAllForwardings=yes");
      expect(got).toEqual(expect.arrayContaining(["ForwardAgent=no", "ForwardX11=no", "PermitLocalCommand=no", "ProxyCommand=none", "ProxyJump=none", "ExitOnForwardFailure=yes", "BatchMode=yes", "ServerAliveInterval=30", "ServerAliveCountMax=3", "-N"]));
      expect(got.slice(got.indexOf("-L"))).toEqual(["-L", `127.0.0.1:${port}:${ip}:6901`, "--", A]);
      expect(got.filter((x) => x === "-L").length).toBe(1);
      expect(got.some((x) => x === "-R" || x === "-D")).toBe(false);
    }
  });
  it("viewer tunnel: anything off the exact shape is refused", async () => {
    const { fake } = recorder();
    const wrapper = await confirmedHome(fake);
    const good = vpsSshTunnelArgs(A, 40123, "172.17.0.2");
    const L = good.indexOf("-L");
    const withL = (spec: string) => good.map((x, i) => (i === L + 1 ? spec : x));
    const bad: Record<string, string[]> = {
      "bind 0.0.0.0": withL("0.0.0.0:40123:172.17.0.2:6901"),
      "bind localhost": withL("localhost:40123:172.17.0.2:6901"),
      "bind empty": withL(":40123:172.17.0.2:6901"),
      "no bind": withL("40123:172.17.0.2:6901"),
      "public target": withL("127.0.0.1:40123:8.8.8.8:6901"),
      "loopback target": withL("127.0.0.1:40123:127.0.0.1:6901"),
      "172.32 target": withL("127.0.0.1:40123:172.32.0.1:6901"),
      "leading zero ip": withL("127.0.0.1:40123:010.0.0.1:6901"),
      "empty octet ip": withL("127.0.0.1:40123:10.0..1:6901"),
      "hex ip": withL("127.0.0.1:40123:0xa.0.0.1:6901"),
      "wrong target port": withL("127.0.0.1:40123:172.17.0.2:22"),
      "port suffix": withL("127.0.0.1:40123:172.17.0.2:69010"),
      "extra field": withL("127.0.0.1:40123:172.17.0.2:6901:1"),
      "low local port": withL("127.0.0.1:1023:172.17.0.2:6901"),
      "high local port": withL("127.0.0.1:65536:172.17.0.2:6901"),
      "leading zero port": withL("127.0.0.1:040123:172.17.0.2:6901"),
      "two -L": [...good.slice(0, -1), "-L", "127.0.0.1:40124:172.17.0.2:6901", A],
      "-R": [...good.slice(0, -1), "-R", "9000:127.0.0.1:22", A],
      "-D": [...good.slice(0, -1), "-D", "1080", A],
      "remote command": [...good, "id"],
      "no -N": good.slice(1),
      "-N not first": [...good.slice(1), "-N"],
      "other host": [...good.slice(0, -1), "other.example.com"],
      "bad interval": good.map((x) => (x === "ServerAliveInterval=30" ? "ServerAliveInterval=3x" : x)),
      "proxy option": good.map((x) => (x === "PermitLocalCommand=no" ? "ProxyCommand=id" : x)),
      "permit yes": good.map((x) => (x === "PermitLocalCommand=no" ? "PermitLocalCommand=yes" : x)),
      "mixed with command mode": ["-T", ...good],
      "tunnel options without -N": good.filter((x) => x !== "-N"),
      "attached -L": [...good.slice(0, L), `-L${good[L + 1]}`, A],
    };
    for (const [name, args] of Object.entries(bad)) {
      const r = sh(wrapper, fake, ...args);
      expect(r.status, name).toBe(255);
      expect(r.stdout, name).toBe("");
    }
  });
  it("shell and TypeScript agree on which target addresses are private", async () => {
    const { fake } = recorder();
    const wrapper = await confirmedHome(fake);
    const ips = ["10.0.0.1", "10.255.255.255", "172.15.0.1", "172.16.0.1", "172.31.0.1", "172.32.0.1", "192.168.0.1", "192.167.0.1", "192.169.0.1", "11.0.0.1", "8.8.8.8", "127.0.0.1", "169.254.1.1", "100.64.0.1",
      "10.0.0.256", "10.0.0.1.1", "10.0.0", "010.0.0.1", "10.00.0.1", "10.0.0.", ".10.0.0.1", "10..0.1", "1e1.0.0.1", "10.0.0.-1", "10.0.0.1 ", " 10.0.0.1", "", "172.016.0.1"];
    for (const ip of ips) {
      const want = isPrivateDockerIpv4(ip);
      let built = true;
      try { vpsSshTunnelArgs(A, 40123, ip); } catch { built = false; }
      expect(built, `ts ${ip}`).toBe(want);
      const good = ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "PermitLocalCommand=no", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-L", `127.0.0.1:40123:${ip}:6901`, A];
      expect(sh(wrapper, fake, ...good).status === 0, `sh ${JSON.stringify(ip)}`).toBe(want);
    }
  });
  it("docker callers (vps-computer runner, container-mcp relay, own-server test): the ssh argv docker derives is accepted in command mode", async () => {
    const { fake, argv } = recorder();
    const wrapper = await confirmedHome(fake);
    const name = vpsContainerName("bot1");
    const callers: Record<string, string[]> = {
      "vps-computer defaultRunner": vpsDockerArgs(A, ["version"]),
      "vps-mcp-relay": vpsContainerMcpArgs(A, name),
    };
    for (const [who, dockerArgs] of Object.entries(callers)) {
      expect(dockerArgs.slice(0, 2), who).toEqual(["-H", `ssh://${A}`]);
      if (dockerBin) {
        // the real docker CLI builds its own ssh argv from -H ssh://alias and runs `ssh` found on PATH
        const r = spawnSync(dockerBin, dockerArgs, { env: { PATH: `${join(dir, "own-server", "bin")}:/usr/bin:/bin` }, encoding: "utf8", timeout: 20000 });
        const got = argv();
        expect(got.slice(0, 2), `${who} ${r.stderr}`).toEqual(["-F", "/dev/null"]);
        expect(got, who).toContain("ClearAllForwardings=yes");
        // Docker 27 sends the remote command as words, Docker 28 and later as one string; the shell on the far side reads both alike.
        const after = tail(got), dash = after.lastIndexOf("--");
        expect(after.slice(dash, dash + 2), who).toEqual(["--", A]);
        expect(after.slice(dash + 2).join(" "), who).toBe("docker system dial-stdio");
        rmSync(join(dir, "argv.txt"));
      } else {
        // docker 27.5.1, recorded: ssh -o ConnectTimeout=30 -T -- <alias> docker system dial-stdio
        const r = sh(wrapper, fake, "-o", "ConnectTimeout=30", "-T", "--", A, "docker", "system", "dial-stdio");
        expect(r.status, who).toBe(0);
        expect(argv(), who).toContain("ClearAllForwardings=yes");
      }
    }
  });
  it("docker callers: the own-server connection test uses the same docker transport", async () => {
    const { fake } = recorder();
    const wrapper = await confirmedHome(fake);
    const seen = calls.length;
    behave = (file) => (file === "docker" ? { stdout: "27.5.1\n" } : file === "ssh-keyscan" ? { stdout: `[server.example.com]:2222 ssh-ed25519 ${BLOB}\n` } : {});
    await testConnection(deps()).catch(() => undefined);
    const docker = calls.slice(seen).find((c) => c.file === "docker");
    if (docker) expect(docker.args.slice(0, 2)).toEqual(["-H", `ssh://${A}`]);
    expect(sh(wrapper, fake, "-o", "ConnectTimeout=30", "-T", "--", A, "docker", "system", "dial-stdio").status).toBe(0);
  });
  const realSsh2 = spawnSync("sh", ["-c", "command -v ssh"], { encoding: "utf8" }).stdout.trim();
  it.skipIf(!realSsh2)("real ssh -G: tunnel mode forwards the viewer port, command mode still clears all forwardings", async () => {
    const fake = fakeSsh(`#!/bin/sh\nexec ${realSsh2} -G "$@"\n`);
    const wrapper = await confirmedHome(fake);
    const field = (out: string, name: string) => out.split("\n").filter((l) => l.startsWith(`${name} `)).map((l) => l.slice(name.length + 1));
    const t = sh(wrapper, fake, ...vpsSshTunnelArgs(A, 40123, "172.17.0.2"));
    expect(t.status, t.stderr).toBe(0);
    console.log(`ssh -G tunnel: localforward ${field(t.stdout, "localforward")}, clearallforwardings ${field(t.stdout, "clearallforwardings")}, exitonforwardfailure ${field(t.stdout, "exitonforwardfailure")}, hostname ${field(t.stdout, "hostname")}, proxycommand ${field(t.stdout, "proxycommand")}`);
    expect(field(t.stdout, "localforward")).toEqual(["[127.0.0.1]:40123 [172.17.0.2]:6901"]);
    expect(field(t.stdout, "clearallforwardings")).toEqual(["no"]);
    expect(field(t.stdout, "exitonforwardfailure")).toEqual(["yes"]);
    expect(field(t.stdout, "remoteforward")).toEqual([]);
    expect(field(t.stdout, "dynamicforward")).toEqual([]);
    expect(field(t.stdout, "forwardagent")).toEqual(["no"]);
    expect(field(t.stdout, "forwardx11")).toEqual(["no"]);
    expect(field(t.stdout, "hostname")).toEqual(["93.184.216.34"]);
    expect(field(t.stdout, "proxycommand")).toEqual([]);
    expect(field(t.stdout, "stricthostkeychecking")).toEqual(["true"]);
    const c = sh(wrapper, fake, "-o", "ConnectTimeout=30", "-T", "--", A, "docker", "system", "dial-stdio");
    console.log(`ssh -G command: clearallforwardings ${field(c.stdout, "clearallforwardings")}, localforward ${field(c.stdout, "localforward")}`);
    expect(field(c.stdout, "clearallforwardings")).toEqual(["yes"]);
  });
});

describe("re-confirming an already confirmed connection", () => {
  const MOVED = "8.8.4.4";
  it("a failure at any confirm step never leaves the old pin next to the new key", async () => {
    const A = OWN_SERVER_ALIAS;
    for (let step = 1; step <= 5; step++) {
      removeTempDirSync(dir);
      mkdirSync(dir);
      const fake = fakeSsh("#!/bin/sh\nexit 0\n");
      await confirmedHome(fake);
      expect(hostKeyConfirmed(deps())).toBe(true);
      const old = readPinnedAddress(deps());
      expect(old).toBe("93.184.216.34");
      // the DNS move: same host and port, new address and a new key
      const NEWBLOB = Buffer.from("another-ed25519-host-key-bytes").toString("base64");
      const moved: OwnServerDeps = { ...deps(), resolve: async () => [MOVED] };
      behave = (file) => (file === "ssh-keyscan" ? { stdout: `[server.example.com]:2222 ssh-ed25519 ${NEWBLOB}\n` } : {});
      const fp = await scanHostKey(moved);
      let n = 0;
      const failAt: OwnServerDeps = { ...moved, beforeWrite: () => { if (++n === step) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); } };
      expect(() => confirmHostKey(fp, failAt), `step ${step}`).toThrow(/ENOSPC/);
      refreshOwnServerFiles(deps());
      const pin = readPinnedAddress(deps());
      if (step < 5) {
        expect(pin, `step ${step}`).toBeNull();
        expect(hostKeyConfirmed(deps()), `step ${step}`).toBe(false);
        expect(wrapperExit(), `step ${step}`).toBe(255);
      } else {
        // the pin was the commit point and the last write is only the wrapper: new key with the NEW address
        expect(pin).toBe(MOVED);
      }
      expect(pin, `step ${step}`).not.toBe(old);
      void A;
    }
  });
  it("saveConnection to a new host drops the pin before known_hosts", async () => {
    const fake = fakeSsh("#!/bin/sh\nexit 0\n");
    await confirmedHome(fake);
    saveConnection({ ...conn, host: "other.example.com" }, deps());
    expect(readPinnedAddress(deps())).toBeNull();
    expect(hostKeyConfirmed(deps())).toBe(false);
  });
});

describe("a child that outlives a failed re-confirm never reaches /usr/bin/ssh", () => {
  it("PATH is bin, refuse-bin, rest; after bin is removed ssh resolves to the refusing shim (docker path and relay path)", async () => {
    const fake = fakeSsh("#!/bin/sh\nexit 0\n");
    await confirmedHome(fake);
    const shim = join(dir, "own-server", "refuse-bin");
    const bin = join(dir, "own-server", "bin");
    const base = { PATH: "/usr/bin:/bin", HOME: "/h" };
    const callers: Record<string, NodeJS.ProcessEnv> = {
      "docker runner (vps-computer)": ownServerChildEnv({ ...base }, deps(), true),
      "mcp relay (vps-mcp-relay)": ownServerChildEnv({ ...base }, deps(), true),
    };
    for (const [who, env] of Object.entries(callers)) expect(env.PATH, who).toBe(`${bin}:${shim}:/usr/bin:/bin`);
    // a failed re-confirm: the very first write fails, which removes bin
    const scan = await scanHostKey(deps());
    let n = 0;
    expect(() => confirmHostKey(scan, { ...deps(), beforeWrite: () => { if (++n === 1) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); } })).toThrow(/ENOSPC/);
    expect(existsSync(bin)).toBe(false);
    expect(existsSync(join(shim, "ssh"))).toBe(true);
    for (const [who, env] of Object.entries(callers)) {
      const r = spawnSync("/bin/sh", ["-c", 'p=$(command -v ssh); echo "$p"; ssh murage-own-server docker'], { env: { PATH: env.PATH }, encoding: "utf8" });
      expect(r.stdout.split("\n")[0], who).toBe(join(shim, "ssh"));
      expect(r.status, who).toBe(255);
    }
    // refresh and later saves, removals and failed refreshes never remove refuse-bin
    refreshOwnServerFiles({ ...deps(), beforeWrite: () => { throw new Error("ENOSPC"); } });
    removeConnection(deps());
    expect(existsSync(join(shim, "ssh"))).toBe(true);
  });
  it("throws when the shim cannot be provided", async () => {
    await confirmedHome(fakeSsh("#!/bin/sh\nexit 0\n"));
    const shim = join(dir, "own-server", "refuse-bin");
    removeTempDirSync(shim);
    expect(() => ownServerChildEnv({ PATH: "/usr/bin" }, { ...deps(), beforeWrite: () => { throw new Error("ENOSPC"); } }, true)).toThrow();
    // with writes working the shim is re-created and verified
    expect(ownServerChildEnv({ PATH: "/usr/bin" }, deps(), true).PATH).toContain("refuse-bin");
  });
});
