// B08 evidence retention on native-log export failure: offline fault injection.
//
// The root-owned human spec latches a native export failure in finishCase and,
// in afterAll, calls harness.close(true) so the original native bytes survive
// in the harness data dir. The spec itself only runs against an admitted live
// engine, so this test cannot execute its glue. Instead it (1) source-anchors
// the latch expressions in the spec and (2) drives the real fixture functions
// that glue calls, exportNativeLogs and B08Harness.close, on a real isolated
// harness with an empty explicit fleet, with the arguments the spec passes.
// No engine, model, credential, descriptor, ledger or dispatch is involved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { B08_CASES, caseFileName, exportNativeLogs, pidAlive, startIsolatedHarness } from "./b08-template-behavior-fixture.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const CASE_ID = "cowork/denied-access";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pids whose command line carries the marker, from the OS process table rather than our own bookkeeping. */
function markerPids(marker: string): number[] {
  const listing = spawnSync("/bin/ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  assert.equal(listing.status, 0, `ps failed: ${listing.stderr}`);
  return listing.stdout.split("\n").filter((line) => line.includes(marker) && !line.includes("/bin/ps")).map((line) => Number.parseInt(line.trim(), 10));
}

function ownedChild(marker: string, home: string): ChildProcess {
  // A synthetic owned process standing in for an engine/MCP child the harness tracks.
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], { stdio: "ignore", env: { HOME: home, PATH: "/usr/bin:/bin" } });
}

const NATIVE_LINES = [
  { at: "2026-09-15T10:00:00.000Z", dir: "in", source: "fuigo.acp", msg: { jsonrpc: "2.0", method: "_fuigo/session/prompt_complete", params: { promptId: "p1", stopReason: "cancelled", cancellationCategory: "PermissionRejected", cancellationContext: { tool_name: "write" } } } },
  { at: "2026-09-15T10:00:00.004Z", dir: "in", source: "fuigo.acp", msg: { jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled", _meta: { promptId: "p1" } } } },
];

/** Writes <dataDir>/native/s1.ndjson strictly after sinceMs, as the harness would during a case. */
async function writeNativeLog(dataDir: string, sinceMs: number): Promise<{ path: string; bytes: Buffer }> {
  await pause(20);
  const native = join(dataDir, "native");
  mkdirSync(native, { recursive: true, mode: 0o700 });
  const path = join(native, "s1.ndjson");
  writeFileSync(path, `${NATIVE_LINES.map((line) => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600 });
  assert.ok(statSync(path).mtimeMs >= sinceMs, "native log mtime must fall inside the case window");
  return { path, bytes: readFileSync(path) };
}

test("the root spec latches native export failure and force-retains through close(true) before throwing", () => {
  const source = readFileSync(new URL("./b08-template-behavior.human.spec.ts", import.meta.url), "utf8");
  const anchors = [
    "try { nativeLogs = exportNativeLogs(need().harness.dataDir, evidence, run.item.id, run.startedAt); }",
    "nativeExportFailure ??= `native log export failed for ${run.item.id}: ${message(exportError)}`;",
    "nativeLogs = { error: message(exportError), retainedSource: need().harness.dataDir };",
    "const harnessCleanup = await state.harness.close(Boolean(cleanupFailure || nativeExportFailure))",
    "...(nativeExportFailure ? { nativeExportFailure, retainedSource: state.harness.dataDir } : {}) };",
    "cleanupFailure ??= nativeExportFailure;",
    "if (cleanupFailure) throw new Error(cleanupFailure);",
  ];
  const at = anchors.map((anchor) => { const index = source.indexOf(anchor); assert.notEqual(index, -1, `spec anchor missing: ${anchor}`); return index; });
  assert.equal(source.split(anchors[3]!).length, 2, "exactly one afterAll harness close");
  // Latch in finishCase precedes teardown; teardown closes with the latch, records it, and throws only afterwards.
  assert.ok(at[1]! < at[3]! && at[3]! < at[4]! && at[4]! < at[5]! && at[5]! < at[6]!, `anchor order ${at.join(",")}`);
  assert.equal(B08_CASES.some((item) => item.id === CASE_ID), true);
});

test("native export failure retains the original harness bytes while owned processes are confirmed gone", { timeout: 120_000 }, async () => {
  assert.equal(process.env.MURAGE_B08_KEEP_DATA, undefined, "MURAGE_B08_KEEP_DATA must be unset: retention must come from the latch");
  const root = mkdtempSync(join(tmpdir(), "b08-export-retention-"));
  const home = join(root, "synthetic-home"), evidence = join(root, "evidence");
  mkdirSync(home);
  const marker = `b08-export-retention-marker-${randomUUID()}`;
  const child = ownedChild(marker, home);
  let harness: Awaited<ReturnType<typeof startIsolatedHarness>> | undefined;
  let confirmed = false;
  try {
    assert.ok(child.pid);
    harness = await startIsolatedHarness({ repoRoot, parent: root, evidenceDir: join(root, "logs"), instances: {} });
    harness.trackOwnedChild(child.pid);
    assert.deepEqual(markerPids(marker), [child.pid]);
    assert.ok(harness.pids.length >= 1 && harness.pids.every(pidAlive));

    const startedAt = Date.now();
    const original = await writeNativeLog(harness.dataDir, startedAt);
    const originalSha = sha256(original.bytes);

    // Fault injection: the case's export target already exists as a regular file.
    const target = join(evidence, "native", caseFileName(CASE_ID).replace(/\.json$/, ""));
    mkdirSync(join(evidence, "native"), { recursive: true });
    writeFileSync(target, "pre-existing regular file blocks the export directory\n", { mode: 0o600 });
    const blocker = readFileSync(target);

    let exportError: unknown;
    try { exportNativeLogs(harness.dataDir, evidence, CASE_ID, startedAt); }
    catch (error) { exportError = error; }
    assert.ok(exportError instanceof Error, "exportNativeLogs must throw on the blocked target");
    assert.match((exportError as NodeJS.ErrnoException).code ?? "", /^(EEXIST|ENOTDIR)$/);
    // The spec's latch reason, formed from the real thrown error.
    const nativeExportFailure = `native log export failed for ${CASE_ID}: ${exportError.message}`;
    assert.equal(lstatSync(target).isFile(), true);
    assert.deepEqual(readFileSync(target), blocker, "a failed export must not alter the evidence target");
    assert.equal(existsSync(join(target, "MANIFEST.json")), false);
    assert.equal(sha256(readFileSync(original.path)), originalSha, "export failure must not touch the source bytes");

    // Owned-process shutdown, then the spec's teardown call: close(Boolean(cleanupFailure || nativeExportFailure)).
    await waitForExit(child, { signal: "SIGTERM", graceMs: 2_000 });
    const cleanupFailure: string | undefined = undefined;
    const result = await harness.close(Boolean(cleanupFailure || nativeExportFailure));

    assert.deepEqual(result, { pidsGone: true, dataDirRemoved: false });
    assert.equal(pidAlive(child.pid), false);
    assert.equal(harness.pids.some(pidAlive), false);
    assert.deepEqual(markerPids(marker), [], "the marked owned child must be absent from the process table");
    assert.equal(existsSync(harness.dataDir), true);
    assert.equal(existsSync(join(harness.dataDir, "config.json")), true);
    const retained = readFileSync(original.path);
    assert.deepEqual(retained, original.bytes);
    assert.equal(sha256(retained), originalSha);

    console.log(JSON.stringify({
      evidence: "b08 native export failure retention", caseId: CASE_ID, injected: { kind: "regular file at export target", target },
      exportError: { code: (exportError as NodeJS.ErrnoException).code, message: exportError.message }, latchReason: nativeExportFailure,
      closeArgument: true, close: result, serverPids: harness.pids, childPid: child.pid, marker, markerPidsAfter: markerPids(marker),
      dataDir: harness.dataDir, native: { path: original.path, bytes: retained.length, sha256Before: originalSha, sha256After: sha256(retained) },
      keepDataEnv: process.env.MURAGE_B08_KEEP_DATA ?? "unset", credentialUsed: false, engineInstances: 0,
    }));
    confirmed = true;
  } finally {
    await waitForExit(child, { signal: "SIGTERM", graceMs: 2_000 });
    const cleanup = await harness?.close();
    if (confirmed || !harness || cleanup?.pidsGone) rmSync(root, { recursive: true, force: true });
  }
});

test("control: without an export failure close(false) removes the data dir and the exported copy keeps the bytes", { timeout: 120_000 }, async () => {
  assert.equal(process.env.MURAGE_B08_KEEP_DATA, undefined);
  const root = mkdtempSync(join(tmpdir(), "b08-export-retention-control-"));
  const home = join(root, "synthetic-home"), evidence = join(root, "evidence");
  mkdirSync(home);
  const marker = `b08-export-retention-control-${randomUUID()}`;
  const child = ownedChild(marker, home);
  let harness: Awaited<ReturnType<typeof startIsolatedHarness>> | undefined;
  let confirmed = false;
  try {
    assert.ok(child.pid);
    harness = await startIsolatedHarness({ repoRoot, parent: root, evidenceDir: join(root, "logs"), instances: {} });
    harness.trackOwnedChild(child.pid);
    const startedAt = Date.now();
    const original = await writeNativeLog(harness.dataDir, startedAt);
    const exported = exportNativeLogs(harness.dataDir, evidence, CASE_ID, startedAt);
    assert.equal(exported.length, 1);
    assert.equal(exported[0]!.sha256, sha256(original.bytes));

    await waitForExit(child, { signal: "SIGTERM", graceMs: 2_000 });
    const nativeExportFailure: string | undefined = undefined, cleanupFailure: string | undefined = undefined;
    const result = await harness.close(Boolean(cleanupFailure || nativeExportFailure));

    assert.deepEqual(result, { pidsGone: true, dataDirRemoved: true });
    assert.equal(existsSync(harness.dataDir), false);
    assert.deepEqual(markerPids(marker), []);
    assert.equal(sha256(readFileSync(exported[0]!.file)), sha256(original.bytes));
    console.log(JSON.stringify({ evidence: "b08 export retention control", closeArgument: false, close: result, serverPids: harness.pids, childPid: child.pid, exportedSha256: exported[0]!.sha256 }));
    confirmed = true;
  } finally {
    await waitForExit(child, { signal: "SIGTERM", graceMs: 2_000 });
    const cleanup = await harness?.close();
    if (confirmed || !harness || cleanup?.pidsGone) rmSync(root, { recursive: true, force: true });
  }
});
