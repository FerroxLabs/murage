// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudHomeCopy } from "./copy.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import {
  OWN_SERVER_ALIAS, confirmHostKey, ensureKey, handleOwnServerApi, hostKeyConfirmed, isPublicAddress, ownServerAlias,
  ownServerChildEnv, parseKeyscan, readConnection, removeConnection, renderSshConfig, saveConnection, scanHostKey,
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
const deps = (): OwnServerDeps => ({ dataDir: dir, run, resolve: async () => ["93.184.216.34"] });
const conn = { host: "server.example.com", port: 2222, user: "deploy" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murage-own-server-"));
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
    for (const line of [`Host ${OWN_SERVER_ALIAS}`, "HostName server.example.com", "Port 2222", "User deploy", "IdentitiesOnly yes", "StrictHostKeyChecking yes", "BatchMode yes", "ForwardAgent no", "ForwardX11 no"]) expect(text).toContain(line);
    expect(text).toContain(`IdentityFile ${join(dir, "own-server", "id_ed25519")}`);
    expect(text).toContain(`UserKnownHostsFile ${join(dir, "own-server", "known_hosts")}`);
    expect(readConnection(deps())).toEqual(conn);
  });
});

describe("host key", () => {
  it("scans, then writes known_hosts only for the matching fingerprint", async () => {
    saveConnection(conn, deps());
    const fingerprint = await scanHostKey(deps());
    expect(fingerprint).toBe(FINGERPRINT);
    expect(calls.find((c) => c.file === "ssh-keyscan")!.args).toEqual(["-T", "10", "-p", "2222", "-t", "ed25519", "server.example.com"]);
    expect(() => confirmHostKey("SHA256:wrong", deps())).toThrow();
    expect(hostKeyConfirmed(deps())).toBe(false);
    confirmHostKey(fingerprint, deps());
    expect(readFileSync(join(dir, "own-server", "known_hosts"), "utf8")).toBe(`[server.example.com]:2222 ssh-ed25519 ${BLOB}\n`);
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
  it("changing host or port clears known_hosts, same host keeps it", async () => {
    saveConnection(conn, deps());
    confirmHostKey(await scanHostKey(deps()), deps());
    saveConnection({ ...conn, user: "other" }, deps());
    expect(hostKeyConfirmed(deps())).toBe(true);
    saveConnection({ ...conn, port: 22 }, deps());
    expect(hostKeyConfirmed(deps())).toBe(false);
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
});

describe("child environment", () => {
  it("puts the ssh wrapper first on PATH only on a home with a connection", () => {
    const env = { PATH: "/usr/bin", HOME: "/h" };
    expect(ownServerChildEnv(env, deps(), true)).toBe(env);
    saveConnection(conn, deps());
    expect(ownServerChildEnv(env, deps(), false)).toBe(env);
    const out = ownServerChildEnv(env, deps(), true);
    expect(out.PATH).toBe(`${join(dir, "own-server", "bin")}:/usr/bin`);
    const wrapper = readFileSync(join(dir, "own-server", "bin", "ssh"), "utf8");
    expect(wrapper).toContain(`-F '${join(dir, "own-server", "config")}' "$@"`);
    expect(statSync(join(dir, "own-server", "bin", "ssh")).mode & 0o111).not.toBe(0);
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
