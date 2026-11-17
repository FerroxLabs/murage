// Mutant/test producer owner: win-sac-sign; release gate consumer owner: MAIN.
// Run only in an isolated test checkout/container, with evidence outside it.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const common = "scripts/windows-pe-signing.mjs", inventory = "scripts/windows-sac-inventory.mjs", gepa = "scripts/windows-gepa-signing.mjs";
const regressions = "scripts/windows-sac-provenance.test.mjs";
const bypass = ["result = await verifyFrozenWindowsPe(file, pin, record, native);", "result = signed.has(file) ? await native.authenticode(file) : await verifyFrozenWindowsPe(file, pin, record, native);"];
export const windowsSacMutants = [
  { name: "execute-main-before-final-verification", files: { "scripts/after-pack.mjs": [
    ["    // Packaged execution is deferred to afterSign:", "    loadEngineExclusionResource(addons[0], 'win32', 'x64', ENGINE_EXCLUSION_ADDON_VERSION, (command, args, env) => execFileSync(command, args, { env }), packagedElectronBinary(context));\n    // Packaged execution is deferred to afterSign:"]
  ] }, tests: ["scripts/after-pack-windows-signing.test.mjs"], pattern: "RED substituted GUI PE|RED final-boundary substitution" },
  { name: "load-checker-before-other-independent-records", files: { [inventory]: [
    ["await verifyWindowsPeRecords(appOutDir, sources, records, bootstrapTrust ?? await runnerWindowsPeTrust());", "const name = 'resources/engine-exclusion.node'; await verifyFrozenWindowsPe(path.resolve(appOutDir, name), sources.find(pin => pin.path === name), records.find(record => record.path === name), bootstrapTrust ?? await runnerWindowsPeTrust());"]
  ] }, tests: ["scripts/windows-sac-inventory.test.mjs"], pattern: "standalone rejects substituted" },
  { name: "skip-signing-provider-content-pins", files: { "scripts/windows-signing-provider.mjs": [
    ["if (peSha256(actionBytes) !== pin.actionSha256 || peSha256(moduleBytes) !== pin.moduleSha256)", "if (false)"]
  ] }, tests: ["scripts/windows-signing-provider.test.mjs"], pattern: "RED rejects a changed" },
  { name: "signedHere-admission", files: { [inventory]: [bypass] }, tests: [regressions], pattern: "different source version" },
  { name: "iterate-only-recorded-files", files: { [inventory]: [
    ["for (const file of await windowsPeFiles(appOutDir)) {", "for (const file of (await windowsPeFiles(appOutDir)).filter(file => finals.has(path.relative(path.resolve(appOutDir), file).split(path.sep).join('/')))) {"],
    ["for (const pin of sources) {\n    if (!finals.has", "for (const pin of []) {\n    if (!finals.has"]
  ] }, tests: [regressions], pattern: "expected PE paths" },
  { name: "unconditional-GEPA-vendor-sign", files: { [gepa]: [
    ["records.push(await signPinnedWindowsPe(file, sourcePins.get(name)", "await windowsSigningSession(context).sign(file); records.push(await signPinnedWindowsPe(file, sourcePins.get(name)"]
  ] }, tests: [regressions], pattern: "vendor GEPA" },
  { name: "skip-payload-verifier", files: { [common]: [
    ["verifySignedWindowsPe(after.bytes, unsigned);", "void unsigned;"],
    ["verifySignedWindowsPe(bytes, record.unsigned);", "void record.unsigned;"]
  ] }, tests: [regressions], pattern: "GEPA signer mutation" },
  { name: "rebase-source-after-signing", files: { [gepa]: [
    ["normalizeWindowsPeSources, peSha256,", "normalizeWindowsPeSources, windowsPeSourcePinId, peSha256,"],
    ["records.push(await signPinnedWindowsPe(file, sourcePins.get(name), trust, windowsSigningSession(context).sign, { ...identity, path: name }));",
      "await windowsSigningSession(context).sign(file); const pin = sourcePins.get(name); pin.sourceSha256 = peSha256(await readFile(file)); records.push({ path: name, target: pin.target, component: pin.component, version: pin.version, sourcePinId: windowsPeSourcePinId(pin), sourceSha256: pin.sourceSha256, finalSha256: pin.sourceSha256, disposition: 'preserved' });"]
  ] }, tests: [regressions], pattern: "GEPA signer mutation" },
  { name: "missing-source-with-forged-final", files: { [inventory]: [
    bypass, ["if (!pins.has(record.path)) failures.push(`unreviewed final record: ${record.path}`);", "void record;"]
  ] }, tests: [regressions], pattern: "omitted upstream source pin" },
  { name: "missing-GEPA-source-pin", files: { [gepa]: [
    ["const input = manifest.files.find(item => item.path === name);", "const input = manifest.files.find(item => item.path === name); if (!pin) { const inferred = { ...sources[0], path: `resources/gepa-worker/${name}`, sourceSha256: input.sha256 }; sourcePins.set(inferred.path, inferred); sources.push(inferred); continue; }" ]
  ] }, tests: [regressions], pattern: "unpinned upstream GEPA" },
  { name: "ignore-version-join", files: { [common]: [
    ["record.version !== pin.version", "false"]
  ] }, tests: [regressions], pattern: "different source version" },
  { name: "main-EXE-after-freeze-exception", files: { [inventory]: [
    ["result = await verifyFrozenWindowsPe(file, pin, record, native);", "result = name === 'Murage.exe' ? await native.authenticode(file) : await verifyFrozenWindowsPe(file, pin, record, native);"]
  ] }, tests: ["scripts/windows-sac-inventory.test.mjs"], pattern: "refuses any later main EXE change" },
  { name: "stale-compiled-backup-pin", files: { "scripts/windows-upstream-signing.mjs": [
    ["!pin.inputs?.some(input => input.component === \"age\" && input.sha256 === ageDigest)", "false"]
  ] }, tests: ["scripts/windows-upstream-signing.test.mjs"], pattern: "stale compiled age" },
  { name: "copier-re-signs-frozen-GEPA", files: { "scripts/windows-builder-signing.mjs": [
    ["import path from \"node:path\";", "import path from 'node:path'; import { createRequire } from 'node:module'; const b = createRequire(createRequire(import.meta.url).resolve('electron-builder/package.json')); const util = createRequire(b.resolve('app-builder-lib/package.json'))('builder-util');"],
    ["packager.createTransformerForExtraFiles = () => null;", "packager.createTransformerForExtraFiles = () => file => ['.exe', '.dll', '.pyd'].some(ext => file.endsWith(ext)) ? new util.CopyFileTransformer(value => packager.signIf(value)) : null;"]
  ] }, tests: ["scripts/windows-gepa-signing.test.mjs"], pattern: "the configured hook signs every GEPA" }
];

export function runWindowsSacMutants(output) {
  output = path.resolve(output);
  if (!path.relative(process.cwd(), output).startsWith(`..${path.sep}`)) throw Error("MUTANT_EVIDENCE_MUST_BE_OUTSIDE_CHECKOUT");
  fs.mkdirSync(output, { recursive: true });
  const require = createRequire(import.meta.url), vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"), summary = [];
  for (const mutant of windowsSacMutants) {
    const originals = new Map();
    try {
      for (const [file, edits] of Object.entries(mutant.files)) {
        const original = fs.readFileSync(file, "utf8"); originals.set(file, original); let changed = original;
        for (const [before, after] of edits) {
          if (changed.split(before).length !== 2) throw Error(`MUTANT_ANCHOR_NOT_UNIQUE: ${mutant.name}`);
          changed = changed.replace(before, after);
        }
        fs.writeFileSync(file, changed);
      }
      const report = path.join(output, `${mutant.name}.json`);
      const run = spawnSync(process.execPath, [vitest, "run", ...mutant.tests, "-t", mutant.pattern, "--reporter=json", `--outputFile=${report}`], { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      fs.writeFileSync(path.join(output, `${mutant.name}.log`), `${run.stdout ?? ""}${run.stderr ?? ""}`);
      const data = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, "utf8")) : {};
      const failed = (data.testResults ?? []).flatMap(result => result.assertionResults ?? []).filter(result => result.status === "failed");
      const killed = run.status !== 0 && failed.length > 0;
      summary.push({ name: mutant.name, killed, behavioralFailures: failed.length });
      console.log(`${mutant.name}: ${killed ? "KILLED" : "SURVIVED_OR_INVALID"} (${failed.length})`);
    } finally { for (const [file, original] of originals) fs.writeFileSync(file, original); }
  }
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  if (summary.some(result => !result.killed)) throw Error("WINDOWS_SAC_MUTANT_SURVIVED");
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw Error("Usage: node scripts/windows-sac-mutants.mjs EXTERNAL_EVIDENCE_DIRECTORY");
  runWindowsSacMutants(process.argv[2]);
}
