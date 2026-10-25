// SPDX-License-Identifier: AGPL-3.0-or-later
// Lane G (r3): the root launchers are image-pinned regular files; update_software installs a signed release into the idle slot under
// /opt/murage-releases and never touches /usr/local/libexec. The slot, gate and rollback scenarios run in home-commands.test.ts; this
// file pins the pieces around them: one launcher list (with its ABI) shared by the image build and the update, the release producer
// (manifest v3: archive digest, tree digest, launcher ABI), and that the producer's bundle is accepted by the home's own checks.
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = (name: string) => fileURLToPath(new URL(`../../${name}`, import.meta.url));
const read = (name: string) => readFileSync(repo(name), "utf8");
const launcherLines = read("deploy/cloud-home/launchers.txt").split("\n").filter((l) => l && !l.startsWith("#"));
const launchers = launcherLines.filter((l) => !l.startsWith("abi ")).map((l) => l.split(/\s+/u));
const abi = launcherLines[0]!.split(/\s+/u)[1]!;
const sh = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const openssl3 = (bin: string) => /^OpenSSL [3-9]\./.test(sh(bin, ["version"]).stdout ?? "");
const canProduce = process.platform === "linux" && openssl3("openssl") && openssl3("/usr/bin/openssl") && sh("git", ["--version"]).status === 0;

describe("launcher list shared by the image build and update_software (Lane G)", () => {
  it("names exactly the three launchers that live outside /opt/murage, each from a file that exists", () => {
    expect(launchers.map((l) => l[1]).sort()).toEqual(["murage-browser-namespace", "murage-browser-network", "murage-turn-launch"]);
    for (const [source, , mode] of launchers) {
      expect(existsSync(repo(`deploy/cloud-home/${source}`)), source).toBe(true);
      expect(mode).toBe("0755");
    }
  });
  it("build-image.sh installs them through the shared step and no longer by hand, so image and update cannot drift", () => {
    const build = read("deploy/cloud-home/build-image.sh");
    expect(build).toContain("deploy/cloud-home/install-launchers.py /usr/local/libexec/murage-install-launchers");
    expect(build).toContain("/usr/bin/python3 -I -B /usr/local/libexec/murage-install-launchers deploy/cloud-home /usr/local/libexec");
    for (const [source, name] of launchers) expect(build, `${source} -> ${name}`).not.toMatch(new RegExp(`install [^\\n]*${source.replace(/\./gu, "\\.")}`, "u"));
  });
  it("the update validates the release's launcher list and ABI but never installs, links or moves a launcher (image-pinned)", () => {
    const commands = read("deploy/cloud-home/murage-commands");
    expect(commands).toContain('"deploy", "cloud-home"');
    expect(commands).toContain("module.plan(launcher_source)");
    expect(commands).toContain("module.apply_modes(tree, entries)");
    expect(commands).toContain('module.check_abi(tree, trust["launcherAbi"])');
    for (const gone of ["module.swap(", "module.stage(", "module.restore(", "module.cleanup(", "restore_launchers", "launcher_record_file", "os.symlink(LINK_TARGET"]) expect(commands).not.toContain(gone);
    expect(commands).not.toMatch(/ctx\["paths"\]\["libexec"\][^\n]*(rename|replace|symlink|unlink)/u);
  });
  it("install-launchers.py installs atomically, refuses a missing or linked launcher and a manifest below the floor", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-il-"));
    try {
      const src = join(dir, "src");
      const dest = join(dir, "dest");
      mkdirSync(src);
      cpSync(repo("deploy/cloud-home/launchers.txt"), join(src, "launchers.txt"));
      for (const [source] of launchers) writeFileSync(join(src, source), `#!/usr/bin/python3\n# ${source}\n`);
      const ok = sh("python3", ["-I", repo("deploy/cloud-home/install-launchers.py"), src, dest]);
      expect(ok.status, ok.stderr).toBe(0);
      for (const [, name] of launchers) {
        expect(readFileSync(join(dest, name), "utf8")).toContain(name);
        expect(lstatSync(join(dest, name)).isFile()).toBe(true); // regular files, never links (r3 sec. 1.1)
        expect(lstatSync(join(dest, name)).mode & 0o7777).toBe(0o755);
      }
      expect(sh("ls", ["-A", dest]).stdout.split("\n").filter((f) => f.startsWith("."))).toEqual([]);
      // A list without the abi line, or with a malformed one, is refused.
      const noAbi = join(dir, "noabi"); mkdirSync(noAbi);
      writeFileSync(join(noAbi, "launchers.txt"), launcherLines.slice(1).join("\n") + "\n");
      for (const [source] of launchers) cpSync(join(src, source), join(noAbi, source));
      const refusedAbi = sh("python3", ["-I", repo("deploy/cloud-home/install-launchers.py"), noAbi, join(dir, "dest4")]);
      expect(refusedAbi.status).toBe(1); expect(refusedAbi.stderr).toContain("launcher_manifest_invalid");
      expect(read("deploy/cloud-home/launcher-abi").trim()).toBe(abi);
      // Allowlist: exactly the three launchers; any other name (even a well-formed murage-* one) or a changed source is refused.
      for (const line of ["murage-turn-launch.py murage-install-launchers 0755", "murage-egress-proxy.py murage-egress-proxy 0755", "murage-home-start.sh murage-home-start 0755"]) {
        const extra = join(dir, "extra");
        mkdirSync(extra, { recursive: true });
        writeFileSync(join(extra, "launchers.txt"), `${readFileSync(join(src, "launchers.txt"), "utf8")}${line}\n`);
        for (const [source] of launchers) cpSync(join(src, source), join(extra, source));
        const refusedName = sh("python3", ["-I", repo("deploy/cloud-home/install-launchers.py"), extra, join(dir, "dest3")]);
        expect(refusedName.status, line).toBe(1);
        expect(refusedName.stderr, line).toContain("launcher_not_allowed");
        expect(existsSync(join(dir, "dest3")), line).toBe(false);
      }
      rmSync(join(src, launchers[2]![0]!));
      const missing = sh("python3", ["-I", repo("deploy/cloud-home/install-launchers.py"), src, join(dir, "dest2")]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("launchers_missing");
      expect(existsSync(join(dir, "dest2"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The release is made in three steps (LANE-G r3 sec. 2, Grok ruling d): PREPARE on the builder (no key), SIGN on the Mac (key only), FINALIZE on the
// builder (verifies the signature, re-checks the published bytes). ARCH is always explicit.
describe.skipIf(!canProduce)("scripts/cloud-home-release.sh prepare + cloud-home-sign.sh + finalize (the release bundle producer)", () => {
  const work = mkdtempSync(join(tmpdir(), "murage-release-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const source = join(work, "source");
  const tree = join(work, "tree");
  const key = join(work, "release.key");
  const pub = join(work, "release.pub");
  const release = repo("scripts/cloud-home-release.sh");
  const signer = repo("scripts/cloud-home-sign.sh");
  const arch = sh("uname", ["-m"]).stdout.trim();
  const otherArch = arch === "x86_64" ? "aarch64" : "x86_64";
  const git = (...args: string[]) => sh("git", ["-c", "user.name=ci", "-c", "user.email=ci@example.test", ...args], { cwd: source });
  // A 20-byte ELF header: class 2 (64-bit), little endian, e_type 2, e_machine 0x3e (x86_64) or 0xb7 (aarch64).
  const elf = (machine: string) => Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, machine === "x86_64" ? 0x3e : 0xb7, 0]);
  const setupTree = (dir: string, src: string, machine = arch) => {
    cpSync(join(src, "deploy"), join(dir, "deploy"), { recursive: true });
    mkdirSync(join(dir, "dist-server"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "dist-server/cloud-home-supervisor.js"), "// supervisor\n");
    writeFileSync(join(dir, "dist-server/index.js"), "// server\n");
    writeFileSync(join(dir, "bin/fuigo"), elf(machine));
  };
  let revision = "";
  const prepare = (name: string, opts: { arch?: string; src?: string; treeDir?: string; rev?: string; seq?: string; env?: NodeJS.ProcessEnv } = {}) =>
    sh("bash", [release, "prepare", opts.arch ?? arch, opts.rev ?? revision, opts.src ?? source, opts.treeDir ?? tree, opts.seq ?? "9", join(work, name)], { env: { ...process.env, ...opts.env } });
  const sign = (manifest: string, seq: string, over: { rev?: string; arch?: string; env?: NodeJS.ProcessEnv } = {}) =>
    sh("bash", [signer, manifest, over.rev ?? revision, over.arch ?? arch, seq], { env: { ...process.env, MURAGE_RELEASE_SIGNING_KEY: key, ...over.env } });
  const finalize = (name: string, over: { arch?: string; rev?: string; pubkey?: string } = {}) =>
    sh("bash", [release, "finalize", over.arch ?? arch, over.rev ?? revision, join(work, name), over.pubkey ?? pub]);
  // The three steps end to end for one sequence; returns the output directory.
  const full = (name: string, seq: string) => {
    const made = prepare(name, { seq });
    expect(made.status, made.stdout + made.stderr).toBe(0);
    const signed = sign(join(work, name, arch, "manifest.json"), seq);
    expect(signed.status, signed.stdout + signed.stderr).toBe(0);
    return join(work, name);
  };

  it("prepares a bundle from the tree of one revision, signs it, and finalizes it under the home's own checks; a tree that is not that revision is refused", () => {
    mkdirSync(join(source, "deploy/cloud-home"), { recursive: true });
    for (const file of ["murage-commands", "install-launchers.py", "launchers.txt", "launcher-abi", "murage-home-launch.py", ...launchers.map((l) => l[0]!)]) {
      cpSync(repo(`deploy/cloud-home/${file}`), join(source, "deploy/cloud-home", file));
    }
    expect(git("init", "-q").status).toBe(0);
    expect(git("add", "-A").status).toBe(0);
    expect(git("commit", "-q", "-m", "release source").status).toBe(0);
    revision = git("rev-parse", "HEAD").stdout.trim();
    setupTree(tree, source);
    expect(sh("openssl", ["genpkey", "-algorithm", "ed25519", "-out", key]).status).toBe(0);
    expect(sh("openssl", ["pkey", "-in", key, "-pubout", "-out", pub]).status).toBe(0);
    const out = join(work, "out");
    const made = prepare("out", { seq: "7" });
    expect(made.status, made.stdout + made.stderr).toBe(0);
    const manifestPath = join(out, arch, "manifest.json");
    expect(existsSync(join(out, arch, "manifest.json.sig"))).toBe(false);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual(["arch", "archive", "bytes", "format", "launcherAbi", "revision", "sequence", "sha256", "treeSha256"]);
    expect(manifest).toMatchObject({ format: "murage-cloud-home-release-v3", sequence: 7, revision, arch, archive: "murage-cloud-home-7.tar.gz", launcherAbi: abi });
    expect(manifest.treeSha256).toMatch(/^[0-9a-f]{64}$/u);
    const signed = sign(manifestPath, "7");
    expect(signed.status, signed.stdout + signed.stderr).toBe(0);
    expect(readFileSync(join(out, arch, "manifest.json.sig")).length).toBe(64);
    const done = finalize("out");
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(done.stdout).toContain("MURAGE_RELEASE_MANIFEST=");
    const listing = sh("tar", ["-tzf", join(out, arch, "murage-cloud-home-7.tar.gz")]).stdout.split("\n");
    expect(listing).toContain("deploy/cloud-home/launchers.txt");
    expect(listing).toContain("dist-server/index.js");
    expect(listing).not.toContain("./");
    // A launcher edited after the build is not the revision's: refused, nothing written.
    writeFileSync(join(tree, "deploy/cloud-home/murage-turn-launch.py"), "# tampered\n");
    const refused = prepare("out2", { seq: "8" });
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toContain("is not the one in");
    expect(existsSync(join(work, "out2"))).toBe(false);
    cpSync(join(source, "deploy/cloud-home/murage-turn-launch.py"), join(tree, "deploy/cloud-home/murage-turn-launch.py"));
  });

  it("prepare takes ARCH explicitly and refuses a bad arch, a missing arch, an arch that is not the tree's, and a signing key in its environment", () => {
    for (const bad of ["arm64", "amd64", "x86-64", "", "X86_64", "x86_64 "]) {
      const refused = prepare("out-bad-arch", { arch: bad });
      expect(refused.status, JSON.stringify(bad)).not.toBe(0);
      expect(existsSync(join(work, "out-bad-arch")), JSON.stringify(bad)).toBe(false);
    }
    const missing = sh("bash", [release, "prepare"], { env: process.env });
    expect(missing.status).not.toBe(0);
    // Valid word, wrong tree: the tree's bin/fuigo is built for the other architecture.
    const wrongTree = join(work, "wrong-arch-tree");
    setupTree(wrongTree, source, otherArch);
    const mismatch = prepare("out-mismatch", { treeDir: wrongTree });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stdout).toMatch(/is not a .* ELF|is aarch64, not|is x86_64, not/u);
    expect(existsSync(join(work, "out-mismatch"))).toBe(false);
    // The operator names the other arch of a correct tree: same refusal.
    const named = prepare("out-named", { arch: otherArch });
    expect(named.status).not.toBe(0);
    expect(existsSync(join(work, "out-named"))).toBe(false);
    // A tree without bin/fuigo cannot confirm its architecture.
    const bare = join(work, "bare-tree");
    cpSync(tree, bare, { recursive: true });
    rmSync(join(bare, "bin"), { recursive: true });
    const noBinary = prepare("out-bare", { treeDir: bare });
    expect(noBinary.status).not.toBe(0);
    expect(noBinary.stdout).toContain("bin/fuigo");
    // Prepare holds no key: one in the environment is refused, never used.
    const withKey = prepare("out-key", { env: { MURAGE_RELEASE_SIGNING_KEY: key } });
    expect(withKey.status).not.toBe(0);
    expect(existsSync(join(work, "out-key"))).toBe(false);
    const text = readFileSync(release, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(text).not.toMatch(/uname/u);
    expect(text).not.toMatch(/pkeyutl -sign|-inkey "\$key"/u);
  });

  it("sign refuses a manifest that is not exactly the canonical one for the named revision, arch and sequence, and refuses a key that is not the expected one", () => {
    const out = full("out-sign", "12");
    const path = join(out, arch, "manifest.json");
    const good = readFileSync(path, "utf8");
    const sigPath = `${path}.sig`;
    rmSync(sigPath);
    const attempts: Array<[string, () => ReturnType<typeof sign>]> = [
      ["other sequence", () => sign(path, "13")],
      ["other revision", () => sign(path, "12", { rev: "f".repeat(40) })],
      ["other arch", () => sign(path, "12", { arch: otherArch })],
      ["bad arch word", () => sign(path, "12", { arch: "arm64" })],
      ["short revision", () => sign(path, "12", { rev: "abc" })],
      ["not OpenSSL 3", () => sign(path, "12", { env: { MURAGE_OPENSSL: "/bin/false" } })],
      ["wrong public key", () => { const other = join(work, "other.pem"); const otherPub = join(work, "other.pub");
        sh("openssl", ["genpkey", "-algorithm", "ed25519", "-out", other]); sh("openssl", ["pkey", "-in", other, "-pubout", "-out", otherPub]);
        return sign(path, "12", { env: { MURAGE_RELEASE_PUBLIC_KEY: otherPub } }); }],
    ];
    for (const [name, run] of attempts) {
      const result = run();
      expect(result.status, name).not.toBe(0);
      expect(existsSync(sigPath), `${name}: a signature was written`).toBe(false);
    }
    const edits: Array<[string, string]> = [
      ["extra field", good.replace(/\}$/u, ',"extra":1}')],
      ["trailing newline", `${good}\n`],
      ["whitespace", good.replace('","sequence"', '", "sequence"')],
      ["bad format", good.replace("release-v3", "release-v2")],
      ["bad digest", good.replace(/"sha256":"[0-9a-f]{64}"/u, '"sha256":"zz"')],
      ["bad archive name", good.replace("murage-cloud-home-12.tar.gz", "../evil.tar.gz")],
      ["archive of another sequence", good.replace("murage-cloud-home-12.tar.gz", "murage-cloud-home-11.tar.gz")],
      ["bad abi", good.replace(/"launcherAbi":"[^"]*"/u, '"launcherAbi":"-x"')],
      ["empty", ""],
    ];
    for (const [name, text] of edits) {
      const bad = join(work, "bad-manifest.json");
      writeFileSync(bad, text);
      const result = sign(bad, "12");
      expect(result.status, name).not.toBe(0);
      expect(existsSync(`${bad}.sig`), `${name}: a signature was written`).toBe(false);
    }
    // The key is read from the environment path only: it is never an argument, and the script prints and writes nothing of it.
    const ok = sign(path, "12");
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout + ok.stderr).not.toContain("PRIVATE KEY");
    const signerText = readFileSync(signer, "utf8");
    expect(signerText).toContain('key=${MURAGE_RELEASE_SIGNING_KEY:?');
    expect(signerText).toContain("unset MURAGE_RELEASE_SIGNING_KEY");
    expect(signerText.split("\n").filter((line) => line.includes('-inkey "$key"') && !line.startsWith("#"))).toHaveLength(1);
    const code = signerText.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\b(python3?|sha256sum|stat -c|pnpm|find -printf)\b|\btar +-/u);
    expect(readdirSync(join(out, arch)).sort()).toEqual(["manifest.json", "manifest.json.sig", "murage-cloud-home-12.tar.gz"]);
  });

  it("the signature is the 64 raw Ed25519 bytes murage-commands verify_signature accepts; a manifest edited after signing is rejected by verify_signature and by finalize", () => {
    const out = full("out-roundtrip", "14");
    const path = join(out, arch, "manifest.json");
    const check = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("mc", sys.argv[1]); spec = importlib.util.spec_from_loader(loader.name, loader)
home = importlib.util.module_from_spec(spec); loader.exec_module(home)
raw = open(sys.argv[2], "rb").read(); signature = open(sys.argv[2] + ".sig", "rb").read(); key = sys.argv[3]
assert len(signature) == 64
assert home.verify_signature(raw, signature, key) is True
edited = raw.replace(b'"sequence":14', b'"sequence":15')
assert edited != raw and home.verify_signature(edited, signature, key) is False
assert home.verify_manifest({"verify": home.verify_signature}, raw, signature, key)["sequence"] == 14
try:
    home.verify_manifest({"verify": home.verify_signature}, edited, signature, key)
    raise SystemExit("edited manifest accepted")
except ValueError as error:
    assert str(error) == "release_signature"
print("verify_signature ok")
`;
    const verified = sh("python3", ["-I", "-c", check, repo("deploy/cloud-home/murage-commands"), path, pub]);
    expect(verified.status, verified.stdout + verified.stderr).toBe(0);
    expect(verified.stdout).toContain("verify_signature ok");
    expect(finalize("out-roundtrip").status).toBe(0);
    // Edited after signing, the same bytes on disk: finalize rejects it and says why.
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace('"sequence":14', '"sequence":15'));
    const rejected = finalize("out-roundtrip");
    expect(rejected.status).not.toBe(0);
    writeFileSync(path, original);
    // A signature from another key is rejected, a missing signature is rejected, a truncated one is rejected.
    const sigPath = `${path}.sig`;
    const sigBytes = readFileSync(sigPath);
    expect(finalize("out-roundtrip", { pubkey: key }).status).not.toBe(0);
    writeFileSync(sigPath, sigBytes.subarray(0, 63));
    expect(finalize("out-roundtrip").status).not.toBe(0);
    rmSync(sigPath);
    expect(finalize("out-roundtrip").status).not.toBe(0);
    writeFileSync(sigPath, sigBytes);
    expect(finalize("out-roundtrip").status).toBe(0);
    // Finalize checks the revision and arch it is told against what was signed.
    expect(finalize("out-roundtrip", { rev: "e".repeat(40) }).status).not.toBe(0);
    expect(finalize("out-roundtrip", { arch: otherArch }).status).not.toBe(0);
  });

  it("runs no code from the revision, the tree or the archive while preparing: a payload that executes on import never runs", () => {
    const hostile = join(work, "hostile");
    const hostileTree = join(work, "hostile-tree");
    const marker = join(work, "PAYLOAD-RAN");
    mkdirSync(join(hostile, "deploy/cloud-home"), { recursive: true });
    for (const file of ["murage-commands", "install-launchers.py", "launchers.txt", "launcher-abi", "murage-home-launch.py", ...launchers.map((l) => l[0]!)]) {
      cpSync(repo(`deploy/cloud-home/${file}`), join(hostile, "deploy/cloud-home", file));
    }
    for (const file of ["murage-commands", "install-launchers.py"]) {
      appendFileSync(join(hostile, "deploy/cloud-home", file), `\nopen(${JSON.stringify(marker)}, "w").write("ran")\n`);
    }
    const gitHostile = (...args: string[]) => sh("git", ["-c", "user.name=ci", "-c", "user.email=ci@example.test", ...args], { cwd: hostile });
    expect(gitHostile("init", "-q").status).toBe(0);
    expect(gitHostile("add", "-A").status).toBe(0);
    expect(gitHostile("commit", "-q", "-m", "hostile").status).toBe(0);
    const hostileRevision = gitHostile("rev-parse", "HEAD").stdout.trim();
    setupTree(hostileTree, hostile);
    const made = prepare("out-hostile", { src: hostile, treeDir: hostileTree, rev: hostileRevision, seq: "10" });
    expect(made.status, made.stdout + made.stderr).toBe(0);
    expect(existsSync(marker), "payload code ran during prepare").toBe(false);
    expect(readFileSync(release, "utf8")).not.toMatch(/\$work\/(murage-commands|install-launchers\.py)/u);
  });

  it("archives a file named like a tar option as data: no option is read from a file name, no side effect happens", () => {
    const hostile = join(work, "option-tree");
    cpSync(tree, hostile, { recursive: true });
    const names = ["--checkpoint=1", "--checkpoint-action=exec=touch OPTION-RAN", "--to-command=touch OPTION-RAN", "-T"];
    for (const name of names) writeFileSync(join(hostile, name), "data\n");
    const cwd = join(work, "option-cwd");
    mkdirSync(cwd, { recursive: true });
    const made = spawnSync("bash", [release, "prepare", arch, revision, source, hostile, "11", join(work, "out-option")], { cwd, encoding: "utf8", env: process.env });
    expect(made.status, made.stdout + made.stderr).toBe(0);
    for (const where of [cwd, hostile, work]) expect(existsSync(join(where, "OPTION-RAN")), `exec side effect in ${where}`).toBe(false);
    const listing = sh("tar", ["-tzf", join(work, "out-option", arch, "murage-cloud-home-11.tar.gz")]).stdout.split("\n");
    for (const name of names) expect(listing, name).toContain(name);
  });

  it("detects a swap of the prepared files while they are published (published must equal checked)", () => {
    const shim = join(work, "shim");
    mkdirSync(shim, { recursive: true });
    const realInstall = sh("sh", ["-c", "command -v install"]).stdout.trim();
    for (const [name, victim] of [["archive", "murage-cloud-home-9.tar.gz"], ["manifest", "manifest.json"]] as const) {
      const dir = join(shim, name);
      mkdirSync(dir, { recursive: true });
      // After the real install copies the files, the shim swaps one of them: what a hostile process racing the publish would do.
      writeFileSync(join(dir, "install"), `#!/bin/sh\n${realInstall} "$@" || exit $?\nfor last; do :; done\nprintf x >> "$last/${victim}"\n`);
      chmodSync(join(dir, "install"), 0o755);
      const result = prepare(`out-swap-${name}`, { env: { PATH: `${dir}:${process.env.PATH}` } });
      expect(result.status, name).not.toBe(0);
      expect(result.stdout, name).toMatch(/Prepared .* (differs|is not the one)/u);
    }
  });
});
