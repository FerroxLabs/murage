// S4 / SEC-07 execution record, base c01ee5103.
// Contract: shipped-key verification before Linux ready/install/handoff, strict
// parsing, signed exact-name SHA256, forward semver, deletion and one recovery
// action on refusal. macOS/Windows behavior stays unchanged. Owned files only.
// Checks: this isolated Node fixture, release-key Node test, candidate,
// coordinator, update-errors and vendor-updater Node files. Vitest and native UI
// checks remain unrun under this lane's command limits. No network/build/commit.
// Stop: bounded checks complete or an evidenced blocker; max 8 verification
// rounds. Tests first: expected base failure, module does not exist.
// Round 1: 14 verifier checks pass. GPG interoperability is environment-blocked:
// gpg-agent cannot bind its isolated socket (Operation not permitted). Keep
// this required case enabled; no product correction or skip substitutes for it.
// Final receipt, 2026-10-03: rounds 3/8, unsuccessful product corrections 0/8.
// Round 2 added continuation/locale proof (17 pass); round 3 bound the signed
// artifact to the selected package type (18 pass). GPG remains 1 environment
// failure, 0 skipped. Reused passes: candidate 17, coordinator 38, errors 2,
// vendor-updater 8, release-key 3. The release guard rejects the shipped TEST
// key and precedes packaging in mac/windows/linux. git diff --check passes.
// Implemented, uncommitted, not release-qualified. Next required check: run
// this file where an isolated gpg-agent can bind a local socket. Vitest
// updater/release-workflow/renderer tests and native visual checks are unrun
// under the lane's limits. Real publisher key remains Sean's later input.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, access, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import test from "node:test";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { captureUpdateCandidate } from "./updater-candidate.mjs";
import { verifyLinuxUpdate, parseReleaseKey, verifyDetachedSignature } from "./update-signature.mjs";

const refusal = "This update could not be verified, so Murage did not install it.";
const errorCode = "ERR_MURAGE_UPDATE_VERIFICATION";
const name = "Murage-2.0.0-x86_64.AppImage";
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const packet = (tag, body) => Buffer.concat([Buffer.from([0xc0 | tag, 255]), u32(body.length), body]);
const mpi = (value) => {
  let b = Buffer.from(value);
  while (b.length && b[0] === 0) b = b.subarray(1);
  return Buffer.concat([u16(b.length ? (b.length - 1) * 8 + 32 - Math.clz32(b[0]) : 0), b]);
};
function armor(kind, bytes, comment = "") {
  let crc = 0xb704ce;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let i = 0; i < 8; i++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x1864cfb; }
  }
  const check = Buffer.from([(crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]).toString("base64");
  return `-----BEGIN PGP ${kind}-----\n${comment ? `Comment: ${comment}\n` : ""}\n${bytes.toString("base64").match(/.{1,64}/g).join("\n")}\n=${check}\n-----END PGP ${kind}-----\n`;
}
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const body = Buffer.concat([Buffer.from([4]), u32(1700000000), Buffer.from([22, 9]), Buffer.from("2b06010401da470f01", "hex"), mpi(Buffer.concat([Buffer.from([0x40]), raw]))]);
  const framed = Buffer.concat([Buffer.from([0x99]), u16(body.length), body]);
  const fingerprint = createHash("sha1").update(framed).digest();
  return { privateKey, fingerprint, publicKey: armor("PUBLIC KEY BLOCK", packet(6, body)) };
}
function signed(data, key, { type = 0, hash = 8, algo = 22, issuer = key.fingerprint, extra = Buffer.alloc(0) } = {}) {
  const subpackets = Buffer.concat([Buffer.from([22, 33, 4]), issuer, Buffer.from([5, 2]), u32(1700000001), extra]);
  const prefix = Buffer.concat([Buffer.from([4, type, algo, hash]), u16(subpackets.length), subpackets]);
  const digest = createHash(hash === 10 ? "sha512" : hash === 2 ? "sha1" : "sha256").update(data).update(prefix).update(Buffer.concat([Buffer.from([4, 255]), u32(prefix.length)])).digest();
  const sig = sign(null, digest, key.privateKey);
  return armor("SIGNATURE", packet(2, Buffer.concat([prefix, u16(0), digest.subarray(0, 2), mpi(sig.subarray(0, 32)), mpi(sig.subarray(32))])));
}
const publisher = keypair();
const attacker = keypair();
const sumsFor = (fileName, bytes) => Buffer.from(`${createHash("sha256").update(bytes).digest("hex")}  ${fileName}\n`);
async function fixture(t, { fileName = name, bytes = "publisher app", key = publisher, signatureOptions } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "murage-signature-")));
  t.after(() => safeWipeSync(dir));
  const file = join(dir, fileName);
  await writeFile(file, bytes);
  const sums = sumsFor(fileName, bytes);
  const assets = { sums, signature: signed(sums, key, signatureOptions) };
  const fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/github.com\/FerroxLabs\/murage-releases\/releases\/download\/v2\.0\.0\/SHA256SUMS-ubuntu-x64\.txt(?:\.asc)?$/);
    assert.equal(options.redirect, "manual");
    return new Response(String(url).endsWith(".asc") ? assets.signature : assets.sums);
  };
  return { file, dir, assets, options: { files: [file], version: "2.0.0", currentVersion: "1.9.0", publicKey: publisher.publicKey, fetch } };
}
const rejects = (fn) => assert.rejects(fn, { code: errorCode, message: refusal });

test("valid publisher signature and exact AppImage/deb bytes verify, with SHA256 and SHA512 signatures", async (t) => {
  for (const fileName of [name, "Murage-2.0.0-amd64.deb"]) for (const hash of [8, 10]) {
    const f = await fixture(t, { fileName, signatureOptions: { hash } });
    const receipt = await verifyLinuxUpdate(f.options);
    assert.equal(receipt.fingerprint, publisher.fingerprint.toString("hex"));
    await receipt.recheck();
    await writeFile(f.file, "replacement");
    await rejects(() => receipt.recheck());
  }
});
test("SWAP of artifact and checksums signed by another key is refused, even with forged issuer metadata", async (t) => {
  for (const issuer of [attacker.fingerprint, publisher.fingerprint]) {
    const f = await fixture(t, { bytes: "attacker app", key: attacker, signatureOptions: { issuer } });
    await rejects(() => verifyLinuxUpdate(f.options));
  }
});
test("SWAP of artifact and checksums reusing the old signature is refused", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, "attacker app");
  f.assets.sums = sumsFor(name, "attacker app");
  await rejects(() => verifyLinuxUpdate(f.options));
});
test("signed checksums require identical downloaded bytes", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, "changed bytes");
  await rejects(() => verifyLinuxUpdate(f.options));
});
test("signed filenames must bind the exact version, platform, architecture and downloaded name", async (t) => {
  for (const wrong of ["Murage-1.9.0-x86_64.AppImage", "Murage-2.0.0-arm64.AppImage", "Murage-2.0.0-x64.zip", "../" + name]) {
    const f = await fixture(t);
    f.assets.sums = sumsFor(wrong, "publisher app");
    f.assets.signature = signed(f.assets.sums, publisher);
    await rejects(() => verifyLinuxUpdate(f.options));
  }
  const f = await fixture(t, { fileName: "Murage-1.9.0-x86_64.AppImage" });
  await rejects(() => verifyLinuxUpdate(f.options));
});
test("a signed Linux artifact must match the selected AppImage or deb install mode", async (t) => {
  const f = await fixture(t);
  await verifyLinuxUpdate({ ...f.options, packageType: "AppImage" });
  await rejects(() => verifyLinuxUpdate({ ...f.options, packageType: "deb" }));
  const deb = await fixture(t, { fileName: "Murage-2.0.0-amd64.deb" });
  await verifyLinuxUpdate({ ...deb.options, packageType: "deb" });
  await rejects(() => verifyLinuxUpdate({ ...deb.options, packageType: "AppImage" }));
});
test("rollback and equal precedence are refused; semver prerelease order is enforced", async (t) => {
  const f = await fixture(t);
  for (const currentVersion of ["2.0.0", "2.0.0+old", "3.0.0", "garbage"]) await rejects(() => verifyLinuxUpdate({ ...f.options, currentVersion }));
  for (const currentVersion of ["2.0.0-rc.1", "1.99.99", "2.0.0-alpha.99"]) await verifyLinuxUpdate({ ...f.options, currentVersion });
  for (const [version, currentVersion, accepted] of [
    ["2.0.0-beta.10", "2.0.0-beta.9", true], ["2.0.0-beta.2", "2.0.0-beta.11", false],
    ["2.0.0-rc.1", "2.0.0-beta.z", true], ["2.0.0-alpha.1", "2.0.0-alpha", true],
    ["2.0.0-alpha.1", "2.0.0-alpha.a", false], ["2.0.0-rc.1", "2.0.0", false],
    ["2.0.0-01", "1.0.0", false], ["02.0.0", "1.0.0", false],
  ]) {
    const fileName = `Murage-${version}-x86_64.AppImage`;
    const file = join(f.dir, fileName);
    await writeFile(file, "app");
    const sums = sumsFor(fileName, "app");
    const options = { ...f.options, files: [file], version, currentVersion, fetch: async url => new Response(String(url).endsWith(".asc") ? signed(sums, publisher) : sums) };
    if (accepted) await verifyLinuxUpdate(options); else await rejects(() => verifyLinuxUpdate(options));
  }
});
test("missing assets, network failures, response limits, timeout and HTTPS downgrade all refuse", async (t) => {
  const f = await fixture(t);
  for (const fetch of [
    async () => new Response("", { status: 404 }),
    async url => String(url).endsWith(".asc") ? new Response("", { status: 404 }) : new Response(f.assets.sums),
    async () => { throw new Error("offline"); },
    async () => new Response("x".repeat(65537)),
    async () => new Response("x", { headers: { "content-length": "65537" } }),
    async () => new Response(null, { status: 302, headers: { location: "http://attacker.invalid/sums" } }),
    async () => new Response(null, { status: 302, headers: { location: "https://loop.invalid/sums" } }),
    async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } })),
  ]) await rejects(() => verifyLinuxUpdate({ ...f.options, fetch, timeoutMs: 30 }));
  await rejects(() => verifyLinuxUpdate({ ...f.options, releaseBaseUrl: "http://github.com/releases/" }));
});
test("HTTPS redirects are followed manually to bounded bodies", async (t) => {
  const f = await fixture(t);
  const receipt = await verifyLinuxUpdate({ ...f.options, fetch: async (url, options) => {
    assert.equal(options.redirect, "manual");
    if (String(url).startsWith("https://github.com/")) return new Response(null, { status: 302, headers: { location: `https://assets.example.invalid/${String(url).endsWith(".asc") ? "sig" : "sums"}` } });
    return new Response(String(url).endsWith("sig") ? f.assets.signature : f.assets.sums);
  } });
  await receipt.recheck();
});
test("strict armor, packets, signature type, algorithm, fingerprint, subpackets and hash selection", async (t) => {
  const f = await fixture(t);
  const original = f.assets.signature;
  const bytes = Buffer.from(original.split("\n\n")[1].split("\n=")[0].replaceAll("\n", ""), "base64");
  const body = bytes.subarray(6);
  for (const bad of [
    "", "not armor", original + "trailing", original.replace(/\n=..../, "\n=AAAA"),
    original.replace("BEGIN PGP SIGNATURE", "BEGIN PGP MESSAGE"),
    original.slice(0, -30), armor("SIGNATURE", packet(13, Buffer.from("uid"))),
    signed(f.assets.sums, publisher, { type: 1 }), signed(f.assets.sums, publisher, { hash: 2 }),
    signed(f.assets.sums, publisher, { algo: 1 }), signed(f.assets.sums, publisher, { issuer: attacker.fingerprint }),
    signed(f.assets.sums, publisher, { hash: 9 }),
    signed(f.assets.sums, publisher, { extra: Buffer.from([2, 0xff, 0]) }),
    original.replace(/\n=....\n/, "\n"),
    armor("SIGNATURE", Buffer.concat([bytes, Buffer.from([0])])),
    armor("SIGNATURE", Buffer.concat([bytes, bytes])),
    armor("SIGNATURE", packet(2, body.subarray(0, -1))),
    armor("SIGNATURE", packet(2, Buffer.concat([body, Buffer.from([0])]))),
    armor("SIGNATURE", Buffer.from([0xc2, 224, 0])),
  ]) {
    f.assets.signature = bad;
    await rejects(() => verifyLinuxUpdate(f.options));
  }
  for (const badKey of [publisher.publicKey + "garbage", attacker.publicKey, publisher.publicKey.replace(/\n=..../, "\n=AAAA")]) {
    f.assets.signature = original;
    await rejects(() => verifyLinuxUpdate({ ...f.options, publicKey: badKey }));
  }
});
test("a non-critical notation (gpg 2.5 adds one) verifies; a critical notation refuses", async (t) => {
  const f = await fixture(t);
  const note = (flag) => {
    const name = Buffer.from("rev@gnupg.org"), value = Buffer.from("1");
    const body = Buffer.concat([Buffer.from([0x80, 0, 0, 0]), u16(name.length), u16(value.length), name, value]);
    return Buffer.concat([Buffer.from([body.length + 1, flag]), body]);
  };
  f.assets.signature = signed(f.assets.sums, publisher, { extra: note(20) });
  await verifyLinuxUpdate(f.options);
  f.assets.signature = signed(f.assets.sums, publisher, { extra: note(20 | 128) });
  await rejects(() => verifyLinuxUpdate(f.options));
});
test("malformed or duplicate checksum entries and unsupported download sets refuse", async (t) => {
  const f = await fixture(t);
  for (const sums of [Buffer.from("garbage"), Buffer.concat([f.assets.sums, f.assets.sums]), Buffer.from("\xff"), Buffer.from(`${"a".repeat(64)}  ${name}\rgarbage\n`)]) {
    f.assets.sums = sums;
    f.assets.signature = signed(sums, publisher);
    await rejects(() => verifyLinuxUpdate(f.options));
  }
  for (const files of [[], [f.file, f.file], [null]]) await rejects(() => verifyLinuxUpdate({ ...f.options, files }));
});
function coordinator(f, options = {}) {
  const updater = new EventEmitter();
  const states = [];
  let installed = 0;
  updater.quitAndInstall = () => { installed++; };
  updater.downloadUpdate = async () => { updater.emit("update-downloaded", { version: "2.0.0" }); return [f.file]; };
  const api = createUpdaterCoordinator(updater, patch => states.push(patch), {
    verifyDownload: ({ files, version }) => verifyLinuxUpdate({ ...f.options, files, version }), ...options,
  });
  return { api, updater, states, installed: () => installed };
}
test("coordinator refusal deletes files, stays error with one line and action, and cannot install", async (t) => {
  const f = await fixture(t, { key: attacker });
  const h = coordinator(f);
  let captures = 0;
  Object.defineProperty(h.updater, "downloadedUpdateHelper", { get() { captures++; return null; } });
  await h.api.download();
  assert.deepEqual(h.states.at(-1), { status: "error", message: refusal, action: "download-from-murage" });
  await assert.rejects(access(f.file), { code: "ENOENT" });
  await h.api.install();
  assert.equal(h.installed(), 0);
  assert.equal(captures, 0);
  assert.deepEqual(h.states.at(-1), { status: "error", message: refusal, action: "download-from-murage" });
  h.updater.emit("update-downloaded", { version: "2.0.0" });
  assert.equal(h.states.some(s => s.status === "downloaded"), false);
});
test("coordinator awaits verification before ready and captures no candidate on refusal", async (t) => {
  const f = await fixture(t);
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const h = coordinator(f, { verifyDownload: async ({ files, version }) => { assert.deepEqual(files, [f.file]); assert.equal(version, "2.0.0"); await wait; return verifyLinuxUpdate(f.options); } });
  await Promise.resolve();
  const pending = h.api.download();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.states.at(-1).status, "downloading");
  release();
  await pending;
  assert.equal(h.states.at(-1).status, "downloaded");
});
test("cached bytes are rechecked before restart and deb handoff, including after admission", async (t) => {
  for (const mode of ["restart", "handoff", "admission"]) {
    const f = await fixture(t);
    let handedOff = 0;
    const h = coordinator(f, {
      ...(mode === "handoff" ? { handOffInstall: async () => { handedOff++; } } : {}),
      ...(mode === "admission" ? { beforeInstall: async () => { await writeFile(f.file, "swapped during admission"); return { status: "continue" }; } } : {}),
    });
    await h.api.download();
    if (mode !== "admission") await writeFile(f.file, "swapped after download");
    await h.api.install();
    assert.equal(h.installed(), 0);
    assert.equal(handedOff, 0);
    assert.equal(h.states.at(-1).message, refusal);
    assert.equal(h.states.at(-1).action, "download-from-murage");
    await assert.rejects(access(f.file), { code: "ENOENT" });
  }
});
test("valid verified bytes reach restart and deb handoff", async (t) => {
  for (const mode of ["restart", "handoff"]) {
    const f = await fixture(t, { fileName: mode === "handoff" ? "Murage-2.0.0-amd64.deb" : name });
    let handedOff = 0;
    const h = coordinator(f, mode === "handoff" ? { handOffInstall: async files => { assert.deepEqual(files, [f.file]); handedOff++; } } : {});
    await h.api.download();
    await h.api.install();
    assert.equal(h.installed(), mode === "restart" ? 1 : 0);
    assert.equal(handedOff, mode === "handoff" ? 1 : 0);
    assert.equal(h.states.at(-1).status, mode === "handoff" ? "handed-off" : "installing");
  }
});
test("cached continuation verifies the publisher before admission and rechecks after it", async (t) => {
  for (const mode of ["valid", "forgery", "swap"]) {
    const f = await fixture(t, mode === "forgery" ? { key: attacker } : {});
    const h = coordinator(f);
    const sha512 = createHash("sha512").update(await readFile(f.file)).digest("base64");
    const info = { version: "2.0.0", files: [{ url: name, sha512 }] };
    h.updater.downloadedUpdateHelper = { file: f.file, versionInfo: info, fileInfo: { info: info.files[0] } };
    h.updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: info });
    const candidate = await captureUpdateCandidate(h.updater, { downloadedFiles: [f.file] });
    let admitted = 0;
    const operation = h.api.resumeInstall(candidate, { beforeInstall: async () => {
      admitted++;
      if (mode === "swap") await writeFile(f.file, "replaced during continuation");
      return { status: "continue" };
    } });
    if (mode === "valid") {
      assert.deepEqual(await operation, { status: "install-requested" });
      assert.equal(h.installed(), 1);
    } else {
      await rejects(() => operation);
      assert.equal(h.installed(), 0);
      assert.equal(h.states.at(-1).message, refusal);
      assert.equal(h.states.at(-1).action, "download-from-murage");
      await assert.rejects(access(f.file), { code: "ENOENT" });
    }
    assert.equal(admitted, mode === "forgery" ? 0 : 1);
  }
});
test("both error surfaces use the external-open bridge and every locale carries the action and refusal", async () => {
  for (const file of ["UpdateBanner.tsx", "SettingsModal.tsx"]) {
    const source = await readFile(new URL(`../src/components/${file}`, import.meta.url), "utf8");
    assert.match(source, /openExternal\?\.\("https:\/\/murage\.ai\/download"\)/);
    assert.match(source, /t\("updates.verificationRefused"\)/);
    assert.match(source, /t\("updates.downloadFromMurage"\)/);
  }
  const dir = new URL("../src/locales/", import.meta.url);
  const en = JSON.parse(await readFile(new URL("en.json", dir), "utf8"));
  const hashes = JSON.parse(await readFile(new URL("source-hashes.json", dir), "utf8")).locales;
  assert.equal(en["updates.verificationRefused"], refusal);
  assert.equal(en["updates.downloadFromMurage"], "Download from murage.ai");
  for (const name of (await readdir(dir)).filter(name => name.endsWith(".json") && name !== "source-hashes.json")) {
    const pack = JSON.parse(await readFile(new URL(name, dir), "utf8"));
    for (const key of ["updates.verificationRefused", "updates.downloadFromMurage"]) {
      assert.ok(pack[key]?.trim(), `${name}: ${key}`);
      assert.doesNotMatch(pack[key], /—|\b(?:safe|safely|safety)\b/i);
      if (name !== "en.json") assert.equal(hashes[name.slice(0, -5)][key], createHash("sha256").update(en[key]).digest("hex"));
    }
  }
});
test("actual updater wiring omits verification hooks on darwin/win32 and sets them for both Linux modes", async () => {
  const source = (await readFile(new URL("./updater.mjs", import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/export /g, "").replaceAll("import.meta.url", JSON.stringify(import.meta.url));
  for (const [platform, packageType] of [["darwin", null], ["win32", null], ["linux", null], ["linux", "deb"]]) {
    let received;
    let publish;
    let factoryCalls = 0;
    const autoUpdater = {};
    const context = vm.createContext({ process: { platform }, app: { isPackaged: true, getVersion: () => "1.9.0", getPath: () => "/unused" },
      createRequire: () => () => ({ autoUpdater }), join, HAND_OFF_PACKAGE_TYPES: ["deb"], linuxPackageType: () => packageType,
      createUpdaterCoordinator: (_updater, setState, options) => { received = options; publish = setState; return {}; },
      createLinuxUpdateVerifier: options => {
        factoryCalls++;
        assert.equal(options.packageType, packageType === "deb" ? "deb" : "AppImage");
        return async () => {};
      }, electronIpcMain: {},
    });
    vm.runInContext(source + "\nstartUpdater({ scheduleChecks: false });", context);
    assert.equal(Object.hasOwn(received, "verifyDownload"), platform === "linux");
    assert.equal(factoryCalls, platform === "linux" ? 1 : 0);
    assert.equal(Boolean(received.handOffInstall), packageType === "deb");
    publish({ status: "error", action: "download-from-murage", message: refusal });
    assert.equal(vm.runInContext("publicState().action", context), "download-from-murage");
    publish({ status: "downloading" });
    assert.equal(vm.runInContext("publicState().action", context), undefined);
  }
});
test("real gpg Ed25519 export and detached signatures interoperate in an isolated temporary home", async (t) => {
  const available = spawnSync("gpg", ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") return t.skip("gpg is not installed");
  assert.equal(available.status, 0, available.stderr);
  const home = await mkdtemp(join(tmpdir(), "murage-gpg-"));
  // gpg runs with cwd = home and a relative "." homedir: the gpg on Windows runners is Git for Windows' MSYS build,
  // which treats a native "C:\\..." argument as relative, while the process cwd is translated for it. gpg makes "." absolute.
  t.after(() => { spawnSync("gpgconf", ["--homedir", ".", "--kill", "all"], { cwd: home, timeout: 1000 }); safeWipeSync(home); });
  const gpg = args => {
    const env = { ...process.env }; delete env.GNUPGHOME;
    const result = spawnSync("gpg", ["--homedir", ".", "--no-options", "--batch", "--pinentry-mode", "loopback", "--passphrase", "", ...args], { cwd: home, encoding: "utf8", env, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  gpg(["--quick-generate-key", "Murage TEST KEY (isolated interoperability)", "ed25519", "sign", "0"]);
  const publicKey = gpg(["--armor", "--export"]);
  const data = Buffer.from("independent gpg fixture\n");
  const file = join(home, "sums.txt");
  await writeFile(file, data);
  for (const hash of ["SHA256", "SHA512"]) {
    gpg(["--yes", "--digest-algo", hash, "--armor", "--detach-sign", "sums.txt"]);
    const signature = await readFile(file + ".asc", "utf8");
    assert.equal(verifyDetachedSignature(data, signature, publicKey), parseReleaseKey(publicKey).fingerprint);
  }
});
