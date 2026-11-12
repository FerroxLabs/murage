import { SIGNAL_FIXTURE_SOURCE, SIGNAL_RUNTIME_G0, signalFixtureDir } from "../server/channels/signal/runtime-paths.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { digest, safePath, treeRecords, treeDigest } from "../server/channels/signal/runtime-tree.mjs";
export { digest, safePath, treeRecords, treeDigest };
import { verifyRuntimeTree, withIntegritySchema, assertIntegrityRecord } from "../server/channels/signal/runtime-integrity.mjs";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { z } from "zod";
import { assertSyncEvidence, releaseInputsSchema, verifySignalEvidence } from "../server/channels/signal/evidence.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TARGETS = Object.freeze({
  "darwin-arm64": { native: "libsignal_jni.dylib" },
  "win32-x64": { native: "signal_jni.dll" },
  "linux-x64": { native: "libsignal_jni.so" },
});
export const PIN_PATH = join(ROOT, "server/channels/signal/runtime-pin.json");
// Loaded only by build commands. The startup digest also uses this module in
// the packaged server, where the source checkout and schema do not exist.
let schema;
export const json = path => JSON.parse(readFileSync(path, "utf8"));
const fail = message => { throw Error(`Signal runtime: ${message}`); };
export function assertReleasePin(pin, { fixtureRoot = join(ROOT, SIGNAL_FIXTURE_SOURCE) } = {}) {
  // This check intentionally precedes schema validation: pending pins cannot be
  // made releasable by replacing only the G0 marker or by skipping one hash.
  if (JSON.stringify(pin)?.includes("G0_REQUIRED") || !pin?.g0) fail("G0_REQUIRED: runtime evidence is pending");
  assertRuntimeInputs(pin);
  if (pin.g0.signalCliVersion !== pin.signalCliVersion) fail("G0 version differs from the pin");
  verifySignalEvidence(pin, fixtureRoot);
  return pin;
}

/** Build and source evidence gate. G0-live is the only omitted requirement. */
export function assertRuntimeInputs(pin) {
  if (JSON.stringify(pin)?.includes("G0_REQUIRED")) fail("G0_REQUIRED: runtime inputs are pending");
  schema ??= z.fromJSONSchema(withIntegritySchema(json(join(ROOT, "server/channels/signal/runtime-pin.schema.json"))));
  // Archive descriptors are mandatory build metadata, validated separately
  // from the runtime pin schema (which also represents pending G0 pins).
  const { releaseInputs, ...runtimePin } = pin;
  if (!schema.safeParse(runtimePin).success) fail("invalid runtime pin schema");
  if (!releaseInputsSchema.safeParse(releaseInputs).success) fail("invalid reviewed release inputs");
  if (pin.g0 && pin.g0.signalCliVersion !== pin.signalCliVersion) fail("G0 version differs from the pin");
  if (pin.rateLimitNotSentProof !== null) fail("rate-limit retry proof must stay null for 1.0.19");
  const network = pin.signalNetwork;
  if (network.version !== "2.15.3_unofficial_157") fail("signal-network version differs from the design");
  assertSyncEvidence(pin);
  for (const [target, record] of Object.entries(pin.targets)) {
    assertIntegrityRecord(record, target);
    const paths = record.jars.map(jar => safePath(jar.path));
    if (new Set(paths.map(p => p.toLowerCase())).size !== paths.length || paths.some(p => !p.endsWith(".jar"))) fail(`${target}: invalid jar inventory`);
    if (!paths.includes("signal-cli.jar")) fail(`${target}: signal-cli.jar is required`);
    const dependency = record.jars.find(jar => jar.path === `lib/signal-network-${network.version}.jar`);
    if (!dependency || dependency.sha256 !== network.sha256) fail(`${target}: signal-network jar differs from its coordinate pin`);
    if (!/^25(?:\.[0-9]+)*\+[0-9]+(?:[.-][A-Za-z0-9]+)*$/.test(record.jre.build)) fail(`${target}: a Java 25 build is required`);
    const provenance = record.libsignal.provenance;
    if (provenance.kind === "upstream-jar") {
      if (!paths.includes(safePath(provenance.jar))) fail(`${target}: JNI provenance jar is not pinned`);
      safePath(provenance.entry);
    } else if (target !== "darwin-arm64" || provenance.tag !== record.libsignal.version) {
      fail("source-built JNI must name the pinned libsignal tag on macOS arm64");
    }
  }
  return pin;
}

function requireHash(file, hash, label) {
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || digest(readFileSync(file)) !== hash) fail(`${label} hash mismatch`);
}
export function verifyLicenses(root) {
  const { documents } = json(join(root, "manifest.json"));
  const required = ["signal-cli", "libsignal", "temurin", "classpath-exception"];
  if (!Array.isArray(documents) || required.some(component => !documents.some(d => d.component === component))) fail("required licence documents are missing");
  const paths = new Set();
  for (const doc of documents) {
    safePath(doc.path);
    if (paths.has(doc.path) || !/^[0-9a-f]{64}$/.test(doc.sha256 ?? "")) fail("G0_REQUIRED: licence document pin is pending or duplicated");
    paths.add(doc.path); requireHash(join(root, doc.path), doc.sha256, "licence document");
    if (!readFileSync(join(root, doc.path), "utf8").trim()) fail("licence document is empty");
  }
  return treeRecords(root);
}
async function collectSurfaces(sourceRoot) {
  // B8 owns these declarations. Hashing their actual sources makes this a
  // generated snapshot, not a second hand-maintained surface inventory.
  const { surfaces } = json(join(sourceRoot, "server/channels/signal/signal.inventory.json"));
  const kinds = ["card", "route", "search", "problem", "recovery", "review"];
  if (!Array.isArray(surfaces) || kinds.some(kind => !surfaces.some(s => s.kind === kind))) fail("B8 surface declarations are incomplete");
  const keys = new Set();
  const rows = surfaces.map(surface => {
    const { kind, id, path, why } = surface;
    if (!kinds.includes(kind) || typeof id !== "string" || !id.trim() || typeof why !== "string" || !why.trim() || /[\r\n]/.test(why)) fail("invalid surface declaration");
    const key = `${kind}:${id}`;
    if (keys.has(key)) fail("duplicate surface declaration");
    keys.add(key);
    const bytes = readFileSync(join(sourceRoot, safePath(path)));
    if (!["card", "search"].includes(kind) && !bytes.toString("utf8").includes(id)) fail(`surface missing from source: ${key}`);
    return { kind, id, path, why, sourceSha256: digest(bytes) };
  });
  // Read the same registrations the Settings UI and search index consume.
  // Parse syntax rather than executing renderer modules or counting categories.
  // Kept out of the packaged startup bundle; only inventory generation parses
  // the checkout's registrations with this development dependency.
  const ts = createRequire(import.meta.url)("typescript");
  const registered = new Map(kinds.map(kind => [kind, new Set()]));
  const requireSurface = (kind, id, registrationPath) => {
    registered.get(kind).add(id);
    if (!keys.has(`${kind}:${id}`)) fail(`surface ${kind === "recovery" || kind === "review" ? "action" : kind} is not declared: ${id}`);
    if (registrationPath && surfaces.find(s => s.kind === kind && s.id === id).path !== registrationPath) fail(`surface registration source differs: ${kind}:${id}`);
  };
  const visitFile = (path, visit) => {
    const source = ts.createSourceFile(path, readFileSync(join(sourceRoot, path), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const walk = node => { visit(node); ts.forEachChild(node, walk); };
    walk(source);
  };
  const literal = node => node && ts.isStringLiteralLike(node) ? node.text : undefined;
  const property = (node, name) => node?.properties?.find(p => ts.isPropertyAssignment(p) && p.name.getText().replace(/["']/g, "") === name)?.initializer;
  const signalId = id => typeof id === "string" && /(?:^|[.-])signal(?:$|[.-])/.test(id);
  visitFile("src/lib/settings-card-registry.ts", node => {
    if (!ts.isCallExpression(node) || node.expression.getText() !== "card") return;
    const [name, section, anchor, spec] = node.arguments;
    if (!signalId(literal(name)) && !signalId(literal(anchor)) && !/\bsignal\b/i.test(spec?.getText() ?? "")) return;
    const id = `${literal(property(spec, "idSection")) ?? literal(section)}.${literal(name)}`;
    requireSurface("card", id, "src/lib/settings-card-registry.ts");
    requireSurface("search", id, "src/lib/settings-card-registry.ts"); // APP_SETTINGS_ENTRIES derives every card.
  });
  visitFile("src/lib/settings-index.ts", node => {
    if (ts.isObjectLiteralExpression(node)) {
      const id = literal(property(node, "id"));
      if (id && (signalId(id) || /\bsignal\b/i.test(property(node, "words")?.getText() ?? ""))) requireSurface("search", id, "src/lib/settings-index.ts");
    }
    if (ts.isCallExpression(node) && node.expression.getText() === "bot" && signalId(literal(node.arguments[1]))) {
      requireSurface("search", `bot.${literal(node.arguments[0])}.${literal(node.arguments[1])}`, "src/lib/settings-index.ts");
    }
  });
  const routes = readFileSync(join(sourceRoot, "server/index.ts"), "utf8").matchAll(/["'`]((?:\/api\/signal|\/api\/channels\/signal)\/[A-Za-z0-9_/:.-]+)["'`]/g);
  for (const [, route] of routes) requireSurface("route", route);
  const types = readFileSync(join(sourceRoot, "server/channels/signal/types.ts"), "utf8");
  const problems = types.match(/export type SignalProblem\s*=([\s\S]*?);/)?.[1];
  const actions = types.match(/export type SignalAction\s*=([\s\S]*?)export type RpcId/)?.[1];
  if (!problems || !actions) fail("surface contracts are missing");
  for (const [, id] of problems.matchAll(/"([^"]+)"/g)) requireSurface("problem", id);
  for (const [, fields] of actions.matchAll(/\{([^}]+)\}/g)) {
    const union = fields.match(/action:\s*((?:"[^"]+"\s*(?:\|\s*)?)+)/)?.[1];
    if (!union) fail("surface action contract is missing");
    for (const [, id] of union.matchAll(/"([^"]+)"/g)) {
      requireSurface(/\bdeliveryId\s*:/.test(fields) ? "review" : "recovery", id);
    }
  }
  for (const { kind, id } of surfaces) if (!registered.get(kind).has(id)) fail(`surface declaration has no registration: ${kind}:${id}`);
  return rows.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`, "en"));
}
export async function generateInventory({ runtime, target, probe, pin = json(PIN_PATH), licenseRoot = join(ROOT, "licenses/signal-runtime"), sourceRoot = ROOT, fixtureRoot = join(sourceRoot, SIGNAL_FIXTURE_SOURCE) }) {
  assertReleasePin(pin, { fixtureRoot });
  if (!Object.hasOwn(TARGETS, target)) fail("unsupported target");
  const record = pin.targets[target];
  await verifyRuntimeTree({ root: runtime, pin, target, probe });
  verifyLicenses(licenseRoot);
  const licenses = verifyLicenses(join(runtime, "licenses"));
  if (JSON.stringify(licenses) !== JSON.stringify(record.integrity.licenseRows)) fail("licence copies differ from reviewed documents");
  const canonical = new Map(record.integrity.rows.map(row => [row.path, row]));
  const files = treeRecords(runtime).filter(row => !["signal.inventory.json", "runtime-pin.json"].includes(row.path)).map(row => canonical.get(row.path) ?? row);
  const jars = new Set(record.jars.map(j => j.path));
  for (const file of files) {
    if (!jars.has(file.path) && !record.natives.some(native => native.path === file.path) && !file.path.startsWith("jre/") && !file.path.startsWith("licenses/") && !file.path.startsWith(SIGNAL_RUNTIME_G0 + "/")) fail(`uninventoried runtime file: ${file.path}`);
  }
  return { contract: "murage-signal-inventory/1.0", target, signalCliVersion: pin.signalCliVersion, pinSha256: digest(JSON.stringify(pin)),
    runtime: { ...record, signalNetwork: pin.signalNetwork, licenses, why: "Run the linked Signal device with verified local files." },
    surfaces: await collectSurfaces(sourceRoot), files };
}
export async function verifyInventory(options) {
  const pin = options.pin ?? json(PIN_PATH);
  assertReleasePin(pin, options);
  verifySignalEvidence(pin, signalFixtureDir(options.runtime));
  const actual = await generateInventory({ ...options, pin });
  if (JSON.stringify(json(join(options.runtime, "runtime-pin.json"))) !== JSON.stringify(pin)) fail("packaged pin differs from reviewed pin");
  if (JSON.stringify(json(join(options.runtime, "signal.inventory.json"))) !== JSON.stringify(actual)) fail("surface or runtime inventory differs from staged files");
  return actual;
}

export async function runInventoryCommand(args, { pin = json(PIN_PATH), licenseRoot = join(ROOT, "licenses/signal-runtime"), sourceRoot = ROOT, fixtureRoot = join(sourceRoot, SIGNAL_FIXTURE_SOURCE) } = {}) {
  if (args.length === 1 && args[0] === "--check-surfaces") {
    const surfaces = await collectSurfaces(sourceRoot);
    return `Signal surfaces verified: ${surfaces.length}`;
  }
  if (args.length === 1 && args[0] === "--pin-status" && (!pin?.g0 || JSON.stringify(pin).includes("G0_REQUIRED"))) {
    return "G0_REQUIRED: Signal activation and release are blocked pending reviewed runtime evidence";
  }
  if (args.length === 1 && args[0] === "--assert-runtime-inputs") {
    assertRuntimeInputs(pin);
    if (!pin.releaseInputs) fail("reviewed release inputs are required");
    verifyLicenses(licenseRoot);
    return "Signal runtime inputs verified (G0-live not asserted)";
  }
  assertReleasePin(pin, { fixtureRoot });
  if (args.length === 1 && args[0] === "--assert-release-pin") return "Signal release pin verified";
  if (args.length === 1 && ["--check-pin", "--pin-status"].includes(args[0])) {
    verifyLicenses(licenseRoot);
    return "Signal runtime pin and licence records verified";
  }
  const [runtime, flag, target, mode] = args;
  if (!runtime || flag !== "--target" || !["--check", "--write"].includes(mode) || args.length !== 4) fail("usage: <runtime> --target <os-arch> --check|--write, or --check-pin|--pin-status");
  const options = { runtime: resolve(runtime), target, pin, licenseRoot, sourceRoot, fixtureRoot };
  if (mode === "--write") writeFileSync(join(options.runtime, "signal.inventory.json"), JSON.stringify(await generateInventory(options), null, 2) + "\n");
  await verifyInventory(options);
  return `Verified Signal runtime and surfaces: ${target}`;
}
if (process.argv[1] && basename(process.argv[1]) === "signal-inventory.mjs" && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(await runInventoryCommand(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
