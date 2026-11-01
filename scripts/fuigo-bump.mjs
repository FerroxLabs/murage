#!/usr/bin/env node
// Release-gate step that moves the bundled Fuigo pin (FUIGO-TRUST-V2 N8 as amended by N10).
// Runs on a disposable box only: refuses on darwin without MURAGE_GATE_BOX=1. Never runs a Fuigo binary, runs no
// install scripts, and writes nothing in the repo unless every step passes.
//
//   node scripts/fuigo-bump.mjs --version 1.0.37 --fuigo-checkout <path> --evidence <dir> --base <murage sha>
//     --reviewed-hunks <file> [--murage-git <dir>] [--expected-hashes <FUIGO-1037-HASHES.md>] [--policy <file>]
//     (--real-turns <dir of per-OS evidence> | --real-turns-owed)
//   node scripts/fuigo-bump.mjs --merge-check <bump-x.y.z.json>
//
// --real-turns-owed moves the pin on a branch and records real_turns: "owed". Build step 10 runs --merge-check on the
// bump receipt before the merge: it refuses a receipt that still owes real turns.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TRUST_BASE_TAG = "v1.0.35";
const C = "crates/codegen";
export const MUST_BE_EMPTY = [
  `${C}/fuigo-workspace/src/folder_trust.rs`, `${C}/fuigo-workspace/src/trust.rs`, `${C}/fuigo-workspace/src/folder_trust_grant_tests.rs`,
  `${C}/fuigo-shell/src/agent/mvp_agent/folder_trust_prompt.rs`,
];
// Every changed hunk here needs a sha1 in --reviewed-hunks (Astra M1: no keyword window). The last three carry the
// 1.0.37 move of check_runner_trust into check_spawn_env_with and the client terminal check.
export const EVERY_HUNK_REVIEWED = [
  `${C}/fuigo-shell/src/agent/folder_trust.rs`, `${C}/fuigo-shell/src/agent/mvp_agent/session_setup.rs`,
  `${C}/fuigo-shell/src/session/acp_session_impl/session_setup.rs`, `${C}/fuigo-workspace/src/permission/manager/mod.rs`,
  `${C}/fuigo-tools/src/sandbox_launch.rs`, `${C}/fuigo-shell-terminal/src/adapter.rs`, `${C}/fuigo-workspace/src/permission/exec_risk.rs`,
];
export const TRUST_PROMPT_CALL = "maybe_spawn_interactive_trust_prompt(";

export const sha = (algo, data, encoding = "hex") => createHash(algo).update(data).digest(encoding);
export const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    if (key === "real-turns-owed") out[key] = true;
    else out[key] = argv[++i];
  }
  for (const key of ["version", "fuigo-checkout", "evidence", "base", "reviewed-hunks"]) if (!out[key]) throw new Error(`--${key} is required`);
  if (!/^\d+\.\d+\.\d+$/.test(out.version)) throw new Error("--version must be x.y.z");
  if (!out["real-turns"] === !out["real-turns-owed"]) throw new Error("pass exactly one of --real-turns, --real-turns-owed");
  return out;
};

/** The hunks of a unified diff, each with the sha1 of its text from the @@ line on (the index line never counts). */
export const hunksOf = (diff) => diff.split(/^(?=@@ )/m).slice(1).map((text) => ({ text, sha1: sha("sha1", text) }));

/** Each full `name(...)` call expression in `source`, paren-balanced, in order. */
export const callExpressions = (source, opener) => {
  const calls = [];
  for (let at = source.indexOf(opener); at !== -1; at = source.indexOf(opener, at + 1)) {
    let depth = 0, end = at + opener.length - 1;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      if (source[end] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(at, end + 1));
  }
  return calls;
};

/** Sha-256 values and sha512 integrity in the hash note, by package name. */
export const parseHashNote = (markdown) => {
  const hashes = {};
  for (const line of markdown.split("\n")) {
    const row = /^\| `([^`]+)` \| `([^`]+)` \|$/.exec(line.trim());
    if (!row) continue;
    (hashes[row[1]] ??= {})[row[2].startsWith("sha512-") ? "integrity" : "sha256"] = row[2];
  }
  return hashes;
};

/** prepare-fuigo.mjs with the pin moved: version, provenance comment, every digest. A digest not replaced stops. */
export const movePin = (source, version, gitHead, assets) => {
  const old = /export const FUIGO_VERSION = "([^"]+)"/.exec(source)?.[1];
  if (!old) throw new Error("FUIGO_VERSION not found");
  const oldHead = /report gitHead ([0-9a-f]{40})/.exec(source)?.[1];
  if (!oldHead) throw new Error("gitHead comment not found");
  let next = source.replaceAll(old, version).replaceAll(oldHead, gitHead);
  for (const [target, pin] of Object.entries(assets)) {
    const block = new RegExp(`("${target}": Object\\.freeze\\(\\{[^}]*?tarballSha256: ")[0-9a-f]{64}(",\\s*binarySha256: ")[0-9a-f]{64}"`);
    if (!block.test(next)) throw new Error(`no pin block for ${target}`);
    next = next.replace(block, `$1${pin.tarballSha256}$2${pin.binarySha256}"`);
  }
  return next;
};

// Real-turn evidence, schema 1 (FUIGO-TRUST-V2 N7, N8 step 4). One file per OS, named <os>.json, beside the raw ACP
// log it names. The log is every JSON-RPC message that crossed Fuigo's stdio, one per line, both directions. Facts the
// log can show are read from the log, never from a claim. This stops a mistaken or empty run, not a forged one.
export const REAL_TURN_OSES = Object.freeze({ linux: "linux-", windows: "win32-", macos: "darwin-" });
// Build steps 8: N7 Phase A and B with the N10 reconnect split, f3, g6, plus the 1.0.37 rows. g1 joins with a policy.
export const REAL_TURN_STEPS = Object.freeze(["a", "b", "c", "d", "e", "f", "f2", "f3", "load-undecided", "load-consent2", "load-rejected",
  "g2", "g3", "g4", "g5-auto", "g5-full", "g6", "h", "card-trust", "card-reject", "card-skip",
  "level-ask", "level-auto", "level-full", "level-no-limits"]);
export const WINDOWS_STEPS = Object.freeze(["windows-path-trailing-semicolon", "windows-git-bash"]);
export const ONE_OS_STEP = "g7";
const POLICY_ACK = "fuigo/permissionPolicy";
const FOLDER_TRUST_REQUESTS = new Set(["fuigo/folder_trust/request", "_fuigo/folder_trust/request"]);
const isHex = (value, length) => typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value);

const rpcLogFaults = (text, policySha256) => {
  const faults = [];
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { messages.push(JSON.parse(line)); } catch { faults.push("log line is not JSON"); break; }
  }
  const named = (method) => messages.filter((message) => message?.method === method);
  const inits = named("initialize");
  if (inits.length === 0) faults.push("log has no initialize");
  if (inits.some((message) => message.params?.clientCapabilities?.terminal === true)) faults.push("client offered a terminal");
  if (messages.some((message) => typeof message?.method === "string" && message.method.startsWith("terminal/"))) faults.push("log has a terminal call");
  if (messages.some((message) => message?.params?._meta?.clientTerminal === true)) faults.push("log has clientTerminal");
  if (named("session/prompt").length === 0) faults.push("log has no turn");
  if (!messages.some((message) => FOLDER_TRUST_REQUESTS.has(message?.method))) faults.push("log has no folder trust request");
  if (!named("session/request_permission").length) faults.push("log has no permission request");
  const acks = messages.map((message) => message?.result?._meta?.[POLICY_ACK]?.sha256).filter((ack) => ack !== undefined);
  if (policySha256 ? !acks.includes(policySha256) || acks.some((ack) => ack !== policySha256) : acks.length > 0) faults.push(policySha256 ? "log has no ack of this policy" : "log acks a policy that was not given");
  const sessions = new Set([...named("session/prompt"), ...named("session/load")].map((message) => message.params?.sessionId));
  return { faults, sessions };
};

/** Refuses anything but one full row per OS, bound to this version, source, Murage sha, asset, policy and raw log. */
export const checkRealTurns = (files, want) => {
  const faults = [];
  const names = files.map((file) => file.name).sort();
  const wantNames = Object.keys(REAL_TURN_OSES).map((os) => `${os}.json`).sort();
  if (names.join() !== wantNames.join()) faults.push(`need exactly ${wantNames.join(", ")}, found ${names.join(", ") || "nothing"}`);
  const receipts = [];
  let oneOs = false;
  for (const { name, row, rpcLog } of files) {
    const stop = (text) => faults.push(`${name}: ${text}`);
    const os = name.replace(/\.json$/, "");
    if (!Object.hasOwn(REAL_TURN_OSES, os)) continue;
    if (row?.schema !== 1) { stop("schema is not 1"); continue; }
    if (row.os !== os) stop(`os is ${row.os}`);
    if (row.fuigoVersion !== want.version) stop(`fuigoVersion is ${row.fuigoVersion}`);
    if (typeof row.fuigoVersionLine !== "string" || !row.fuigoVersionLine.split(/[^0-9.]+/).includes(want.version)) stop("the Fuigo version line does not name this version");
    if (row.peeledTag !== want.peeledTag) stop("not this tag commit");
    if (!isHex(row.murageSha, 40) || row.murageSha !== want.murageSha) stop("not this Murage sha");
    if (typeof row.target !== "string" || !row.target.startsWith(REAL_TURN_OSES[os]) || !Object.hasOwn(want.assets, row.target)) stop(`target ${row.target} is not a ${os} asset`);
    else if (row.binarySha256 !== want.assets[row.target].binarySha256) stop("the binary that ran is not the pinned asset");
    if ((row.policySha256 ?? null) !== want.policySha256) stop("policy sha differs");
    if (!Array.isArray(row.launchArgv) || row.launchArgv.includes("--trust") || !row.launchArgv.includes("--no-leader")) stop("launch is not generation 2 (--no-leader, no --trust)");
    if (rpcLog === undefined) { stop("raw ACP log missing"); continue; }
    if (sha("sha256", rpcLog) !== row.rpcLogSha256) stop("raw ACP log does not match rpcLogSha256");
    const { faults: logFaults, sessions } = rpcLogFaults(rpcLog.toString("utf8"), want.policySha256);
    for (const fault of logFaults) stop(fault);
    const needed = [...REAL_TURN_STEPS, ...(want.policySha256 ? ["g1"] : []), ...(os === "windows" ? WINDOWS_STEPS : [])];
    const proven = (id) => row.steps?.[id]?.pass === true && typeof row.steps[id].sessionId === "string" && sessions.has(row.steps[id].sessionId);
    for (const id of needed) if (!proven(id)) stop(`step ${id} has no passing turn in the log`);
    oneOs ||= proven(ONE_OS_STEP);
    receipts.push({ os, target: row.target, binarySha256: row.binarySha256, rpcLogSha256: row.rpcLogSha256, steps: needed.length });
  }
  if (!oneOs) faults.push(`step ${ONE_OS_STEP} has no passing turn on any OS`);
  if (faults.length) throw new Error(`real-turn evidence refused:\n  ${faults.join("\n  ")}`);
  return receipts;
};

/** The files of a --real-turns folder: each row beside the bytes of the log it names. */
export const readRealTurns = (dir) => readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => {
  const row = JSON.parse(readFileSync(join(dir, name), "utf8"));
  const logName = row?.rpcLog;
  const logPath = typeof logName === "string" && /^[\w.-]+$/.test(logName) ? join(dir, logName) : null;
  return { name, row, rpcLog: logPath && existsSync(logPath) ? readFileSync(logPath) : undefined };
});

/** Step 10: a receipt with the real turns in hand, one row per OS. */
export const mergeCheck = (receipt) => {
  const oses = Array.isArray(receipt.real_turns) ? receipt.real_turns.map((row) => row.os).sort().join() : "";
  if (oses !== Object.keys(REAL_TURN_OSES).sort().join()) throw new Error(`Fuigo ${receipt.fuigoVersion}: real turns are owed, this pin cannot merge`);
};

/** Writes every file or none: all staged beside their targets, then renamed; a failure puts back what was there. */
export const commitFiles = (writes, removals = []) => {
  const temp = (path) => `${path}.bump-tmp`;
  const before = new Map([...writes.map(([path]) => path), ...removals].map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
  try {
    for (const [path, text] of writes) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(temp(path), text); }
    for (const [path] of writes) renameSync(temp(path), path);
    for (const path of removals) rmSync(path, { force: true });
  } catch (error) {
    for (const [path, old] of before) { if (old === null) rmSync(path, { force: true }); else writeFileSync(path, old); }
    throw error;
  } finally {
    for (const [path] of writes) rmSync(temp(path), { force: true });
  }
};

const fetchBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
const tarEntry = (tar, wanted) => {
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.toString("utf8", at, at + 100).replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(tar.toString("utf8", at + 124, at + 136).replace(/\0.*$/s, "").trim(), 8);
    if (wanted(name)) return { name, data: tar.subarray(at + 512, at + 512 + size) };
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
};
export const machineHeader = (bin) => {
  if (bin.readUInt32LE(0) === 0xfeedfacf) return { format: "Mach-O64", machine: bin.readUInt32LE(4) };
  if (bin.subarray(0, 4).toString("latin1") === "\x7fELF") return { format: "ELF64", machine: bin.readUInt16LE(18) };
  if (bin.subarray(0, 2).toString("latin1") === "MZ") return { format: "PE", machine: bin.readUInt16LE(bin.readUInt32LE(0x3c) + 4) };
  throw new Error("unknown executable header");
};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

async function provenance(version, registry, targets, expected, checkoutHead) {
  const packages = [];
  const seen = new Set();
  for (const [target, name] of [["wrapper", "fuigo"], ...targets.map(([t, a]) => [t, a.package])]) {
    const meta = JSON.parse((await fetchBytes(`${registry}/${name.replace("/", "%2f")}/${version}`)).toString());
    const archive = await fetchBytes(meta.dist.tarball);
    if (sha("sha512", archive, "base64") !== meta.dist.integrity.replace(/^sha512-/, "")) throw new Error(`${name}: sha512 integrity mismatch`);
    if (sha("sha1", archive) !== meta.dist.shasum) throw new Error(`${name}: sha1 shasum mismatch`);
    if (meta.gitHead !== checkoutHead) throw new Error(`${name}: gitHead ${meta.gitHead} is not the peeled tag ${checkoutHead}`);
    const tarballSha256 = sha("sha256", archive);
    const note = expected?.[name];
    if (expected && (note?.sha256 !== tarballSha256 || note?.integrity !== meta.dist.integrity)) throw new Error(`${name}: differs from the hash note`);
    seen.add(tarballSha256);
    const row = { target, name, gitHead: meta.gitHead, tarball: meta.dist.tarball, tarballSha256, integrity: meta.dist.integrity, shasum: meta.dist.shasum, archiveBytes: archive.length };
    if (target === "wrapper") row.optionalDependencies = meta.optionalDependencies;
    else {
      const tar = gunzipSync(archive);
      const entry = tarEntry(tar, (entryName) => /^package\/bin\/.*\.br$/.test(entryName) || /^package\/bin\/fuigo(\.exe)?$/.test(entryName));
      if (!entry) throw new Error(`${name}: no executable in the archive`);
      const bin = entry.name.endsWith(".br") ? brotliDecompressSync(entry.data) : Buffer.from(entry.data);
      Object.assign(row, { header: { ...machineHeader(bin), target }, binarySha256: sha("sha256", bin), binaryBytes: bin.length });
    }
    packages.push(row);
  }
  return packages;
}

async function main() {
  if (process.argv[2] === "--merge-check") return mergeCheck(JSON.parse(readFileSync(process.argv[3], "utf8")));
  if (process.platform === "darwin" && process.env.MURAGE_GATE_BOX !== "1") throw new Error("release gate only: set MURAGE_GATE_BOX=1 on a disposable box");
  const args = parseArgs(process.argv.slice(2));
  const { version, evidence: evidenceDir } = args;
  const checkout = args["fuigo-checkout"];
  const prepareFile = join(REPO, "scripts/prepare-fuigo.mjs");
  const { FUIGO_ASSETS, FUIGO_REGISTRY } = await import(pathToFileURL(prepareFile).href);

  // Step 2 first: it needs no network. The reviewed source is the peeled tag commit.
  const head = git(checkout, "rev-parse", `v${version}^{commit}`).trim();
  const baseHead = git(checkout, "rev-parse", `${TRUST_BASE_TAG}^{commit}`).trim();
  const changed = [];
  for (const path of MUST_BE_EMPTY) if (git(checkout, "diff", baseHead, head, "--", path).trim()) changed.push(path);
  if (changed.length) throw new Error(`trust protocol changed: re-review FUIGO-TRUST-V2 (${changed.join(", ")})`);
  for (const path of EVERY_HUNK_REVIEWED.filter((item) => item.endsWith("session_setup.rs"))) {
    const at = (rev) => callExpressions(git(checkout, "show", `${rev}:${path}`), TRUST_PROMPT_CALL).join("\n");
    if (at(baseHead) !== at(head)) throw new Error(`trust protocol changed: re-review FUIGO-TRUST-V2 (${path})`);
  }
  const reviewed = new Set(readFileSync(args["reviewed-hunks"], "utf8").split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
  const unreviewed = EVERY_HUNK_REVIEWED.flatMap((path) => hunksOf(git(checkout, "diff", "-U3", baseHead, head, "--", path)).map((hunk) => ({ path, ...hunk }))).filter((hunk) => !reviewed.has(hunk.sha1));
  if (unreviewed.length) {
    for (const hunk of unreviewed) process.stdout.write(`UNREVIEWED ${hunk.sha1} ${hunk.path}\n${hunk.text}\n`);
    throw new Error(`${unreviewed.length} hunk(s) not reviewed: add each sha1 to --reviewed-hunks after reading it`);
  }

  // Step 3.
  const murageGit = args["murage-git"] ?? REPO;
  const murageSha = git(murageGit, "rev-parse", "--verify", `${args.base}^{commit}`).trim();
  const ancestor = spawnSync("git", ["-C", murageGit, "merge-base", "--is-ancestor", "27d10e398", murageSha]);
  if (ancestor.status !== 1) throw new Error("base re-copies trusted_folders.toml (1.0.10 scoped home)");

  // Step 1: registry receipts, the hash note and the release manifest.
  const expected = args["expected-hashes"] ? parseHashNote(readFileSync(args["expected-hashes"], "utf8")) : null;
  const packages = await provenance(version, FUIGO_REGISTRY, Object.entries(FUIGO_ASSETS), expected, head);
  const releaseBase = `https://github.com/FerroxLabs/fuigo/releases/download/v${version}`;
  const manifestBytes = await fetchBytes(`${releaseBase}/release-manifest.json`);
  const manifest = JSON.parse(manifestBytes.toString());
  const sums = (await fetchBytes(`${releaseBase}/SHA256SUMS`)).toString();
  if (manifest.sourceCommit !== head || manifest.version !== version) throw new Error("release-manifest.json names another source or version");
  for (const row of packages) {
    const listed = manifest.packages.find((item) => item.name === row.name);
    if (listed?.integrity !== row.integrity || listed?.shasum !== row.shasum) throw new Error(`${row.name}: differs from release-manifest.json`);
    for (const digest of [row.tarballSha256, row.binarySha256]) if (digest && !sums.includes(`${digest}  `)) throw new Error(`${row.name}: ${digest} is not in SHA256SUMS`);
  }

  // Step 4: real turns, or an explicit record that they are owed. Every input is read before the first write.
  const assets = Object.fromEntries(packages.filter((row) => row.target !== "wrapper").map((row) => [row.target, { tarballSha256: row.tarballSha256, binarySha256: row.binarySha256 }]));
  const policySha256 = args.policy ? sha("sha256", readFileSync(args.policy)) : null;
  const realTurns = args["real-turns"] ? checkRealTurns(readRealTurns(args["real-turns"]), { version, peeledTag: head, murageSha, assets, policySha256 }) : "owed";

  // Step 5: everything passed; only now write, all or nothing.
  const proof = { version, source: head, registry: FUIGO_REGISTRY, verifiedAt: new Date().toISOString(), installScriptsExecuted: false, nativeExecutablesRun: false, packages };
  const moved = movePin(readFileSync(prepareFile, "utf8"), version, head, assets);
  const oldVersion = /export const FUIGO_VERSION = "([^"]+)"/.exec(readFileSync(prepareFile, "utf8"))[1];
  const proofText = `${JSON.stringify(proof, null, 2)}\n`;
  const receipt = { murageSha, fuigoVersion: version, peeledTag: head, trustBase: baseHead, assets, wrapperTarballSha256: packages[0].tarballSha256, releaseManifestSha256: sha("sha256", manifestBytes), policySha256: policySha256 ?? (realTurns === "owed" ? "owed: real-turn step" : "none: this Murage launches no policy file"), real_turns: realTurns };
  commitFiles([
    [join(evidenceDir, `fuigo-${version}-provenance.json`), proofText],
    [join(evidenceDir, "reviewed-hunks.txt"), readFileSync(args["reviewed-hunks"])],
    [join(evidenceDir, `bump-${version}.json`), `${JSON.stringify(receipt, null, 2)}\n`],
    [prepareFile, moved],
    [join(REPO, `scripts/fuigo-${version}-provenance.json`), proofText],
  ], oldVersion !== version ? [join(REPO, `scripts/fuigo-${oldVersion}-provenance.json`)] : []);
  process.stdout.write(`Pinned ${version} (${head}). Commit scripts/prepare-fuigo.mjs and scripts/fuigo-${version}-provenance.json, update the tests and deploy/cloud-home/LICENSES.md.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { process.stderr.write(`fuigo-bump stopped: ${error.message}\n`); process.exit(1); });
}
