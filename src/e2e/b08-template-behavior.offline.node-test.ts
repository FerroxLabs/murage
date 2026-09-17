import assert from "node:assert/strict";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { waitForExit } from "../../server/testing/cleanup.ts";
import {
  B08_CASES, B08_DONE, admitEngineDescriptor, approvalPolicy, approvalRule, boundedClose, canonicalPath, caseStatus, claimEngineDispatch, dispatchHeadroom, dispatchLedgerPath,
  endedByEngineAfterDenial, evaluateRubric, exportNativeLogs, nativeStops, readCredential, prepareReadOnlyTaskWorkspace, retainArtifact, runEvidenceDir, startIsolatedHarness, taskIdentityProblems, unexecutedStatus, writeReceipt,
  type B08EngineDescriptor, type EngineStop,
} from "./b08-template-behavior-fixture.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "b08-correction-offline-"));
  const home = join(root, "synthetic-home"), repoRoot = join(root, "synthetic-repo");
  mkdirSync(home); mkdirSync(repoRoot);
  const descriptor: B08EngineDescriptor = { instanceId: "dedicated", driver: "openai-compat", displayName: "Dedicated local model", model: "local-model", account: "synthetic-account", config: {}, spend: { paid: false, reason: "offline admission only" }, maxDispatches: 24 };
  return { root, home, repoRoot, descriptor, close: () => safeWipeSync(root) };
}

test("admission refuses credential parent symlink into synthetic personal store", () => {
  const f = fixture();
  try {
    const store = join(f.home, ".codex"); mkdirSync(store);
    writeFileSync(join(store, "synthetic-key"), "placeholder-only", { mode: 0o600 });
    symlinkSync(store, join(f.root, "alias"));
    const result = admitEngineDescriptor({ ...f.descriptor, credential: { env: "OPENAI_API_KEY", file: join(f.root, "alias", "synthetic-key") } }, f);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.refusals.join(";"), /personal store/);
  } finally { f.close(); }
});

test("admission resolves config parent aliases including nonexistent descendants", () => {
  const f = fixture();
  try {
    const store = join(f.home, ".claude"); mkdirSync(store);
    symlinkSync(store, join(f.root, "alias"));
    for (const suffix of ["", "new-config/never-created"]) {
      const result = admitEngineDescriptor({ ...f.descriptor, config: { configDir: join(f.root, "alias", suffix) } }, f);
      assert.equal(result.ok, false);
    }
  } finally { f.close(); }
});

test("protected roots themselves are canonicalized, and repo fixture aliases refused", () => {
  const f = fixture();
  try {
    const external = join(f.root, "store-target"); mkdirSync(external);
    symlinkSync(external, join(f.home, ".config"));
    assert.equal(admitEngineDescriptor({ ...f.descriptor, config: { configDir: join(external, "future") } }, f).ok, false);
    mkdirSync(join(f.repoRoot, "server", "testing"), { recursive: true });
    symlinkSync(join(f.repoRoot, "server", "testing"), join(f.root, "test-alias"));
    assert.equal(admitEngineDescriptor({ ...f.descriptor, config: { cli: join(f.root, "test-alias", "cli") } }, f).ok, false);
  } finally { f.close(); }
});

test("dangling aliases fail closed; safe nonexistent path remains admissible", () => {
  const f = fixture();
  try {
    symlinkSync(join(f.root, "absent"), join(f.root, "dangling"));
    assert.throws(() => canonicalPath(join(f.root, "dangling", "child")), /dangling/);
    assert.equal(admitEngineDescriptor({ ...f.descriptor, config: { cli: join(f.root, "dedicated-cli") } }, f).ok, true);
    assert.equal(admitEngineDescriptor({ ...f.descriptor, config: { cli: `${f.root}/alias/../command` } }, f).ok, false);
  } finally { f.close(); }
});

test("credential read rechecks a swapped parent and retains regular-file/mode checks", () => {
  const f = fixture();
  try {
    const safe = join(f.root, "safe"), forbidden = join(f.home, ".murage"), alias = join(f.root, "alias");
    mkdirSync(safe); mkdirSync(forbidden);
    for (const directory of [safe, forbidden]) writeFileSync(join(directory, "key"), "synthetic-placeholder", { mode: 0o600 });
    symlinkSync(safe, alias);
    const descriptor = { ...f.descriptor, credential: { env: "OPENAI_API_KEY" as const, file: join(alias, "key") } };
    assert.equal(admitEngineDescriptor(descriptor, f).ok, true);
    assert.equal(readCredential(descriptor, f).ok, true);
    unlinkSync(alias); symlinkSync(forbidden, alias);
    assert.equal(readCredential(descriptor, f).ok, false);
    descriptor.credential.file = join(safe, "key"); chmodSync(descriptor.credential.file, 0o644);
    assert.equal(readCredential(descriptor, f).ok, false);
    symlinkSync(join(safe, "key"), join(safe, "leaf-link")); descriptor.credential.file = join(safe, "leaf-link");
    assert.equal(readCredential(descriptor, f).ok, false);
  } finally { f.close(); }
});

test("loopback endpoint needs explicit provenance attestation", () => {
  const f = fixture();
  try {
    const raw = { ...f.descriptor, config: { baseUrl: "http://127.0.0.1:9000/v1" } };
    assert.equal(admitEngineDescriptor(raw, f).ok, false);
    assert.equal(admitEngineDescriptor({ ...raw, localEndpointAttestation: "Operator verified dedicated local executable and model; synthetic admission only" }, f).ok, true);
  } finally { f.close(); }
});

test("run receipts stay isolated per run stamp", () => {
  const f = fixture();
  try {
    const override = join(f.root, "evidence"), a = runEvidenceDir(f.root, override, "run-a"), b = runEvidenceDir(f.root, override, "run-b");
    assert.notEqual(a, b);
    writeReceipt(join(a, "SUMMARY.json"), { stale: true });
    writeReceipt(join(a, "calendar-receipt.jsonl"), { stale: true });
    assert.equal(existsSync(join(b, "SUMMARY.json")), false);
    assert.equal(existsSync(join(b, "calendar-receipt.jsonl")), false);
    assert.throws(() => runEvidenceDir(f.root, override, "../escape"), /stamp/);
  } finally { f.close(); }
});

test("the dispatch ledger follows the descriptor, so a fresh evidence directory cannot forget consumed dispatches", () => {
  const f = fixture();
  try {
    const engineFile = join(f.root, "authority", "b08-engine.json");
    writeReceipt(engineFile, { placeholder: true });
    const firstEvidence = join(f.root, "b08-live-evidence-A", "receipts");
    writeReceipt(join(firstEvidence, "run-1", "dispatch-budget.json"), { max: 22, used: 20 });
    writeReceipt(join(firstEvidence, "run-1-attempt1-snapshot", "dispatch-budget.json"), { max: 22, used: 20 });
    writeReceipt(join(firstEvidence, "run-2", "dispatch-budget.json"), { max: 2, used: 2 });
    const ledger = dispatchLedgerPath(engineFile, f.descriptor);
    assert.equal(dirname(ledger), canonicalPath(join(f.root, "authority")));
    // an undeclared history is refused, never assumed empty
    assert.throws(() => dispatchHeadroom(ledger, { ...f.descriptor, maxDispatches: 22 }), /^Error: NOT RUN: no dispatch ledger[^]*priorEvidence/);
    assert.equal(existsSync(ledger), false);
    const exhausted = { ...f.descriptor, maxDispatches: 22, priorEvidence: [firstEvidence] };
    assert.deepEqual(dispatchHeadroom(ledger, exhausted), { used: 22, max: 22, remaining: 0 });
    assert.throws(() => claimEngineDispatch(ledger, exhausted), /NOT RUN: engine dispatch budget 22 reached \(22 used/);
    // a later run writing receipts to a fresh evidence directory reads the same ledger
    const freshEvidence = runEvidenceDir(f.root, join(f.root, "b08-live-evidence-B", "receipts"), "run-c");
    assert.equal(dispatchLedgerPath(engineFile, f.descriptor), ledger);
    assert.throws(() => claimEngineDispatch(ledger, { ...exhausted, priorEvidence: [] }), /budget 22 reached \(22 used/);
    assert.equal(existsSync(join(dirname(freshEvidence), `b08-dispatch-ledger-${f.descriptor.instanceId}.json`)), false);
    // only the root's raised allocation continues, from 22, and it is recorded
    assert.equal(claimEngineDispatch(ledger, { ...exhausted, maxDispatches: 41 }), 23);
    const saved = JSON.parse(readFileSync(ledger, "utf8"));
    assert.deepEqual(saved.allocations.map((item: { max: number }) => item.max), [22, 41]);
    assert.equal(saved.used, 23); assert.equal(saved.legacySeed.length, 2);
  } finally { f.close(); }
});

test("each allocation adds at most one full suite of headroom; another engine identity or a corrupt ledger fails closed", () => {
  const f = fixture();
  try {
    const ledger = dispatchLedgerPath(join(f.root, "b08-engine.json"), f.descriptor);
    assert.throws(() => dispatchHeadroom(ledger, { ...f.descriptor, maxDispatches: 23, priorEvidence: [] }), /at most one full suite \(22\)/);
    const engine = { ...f.descriptor, maxDispatches: 22, priorEvidence: [] };
    assert.equal(claimEngineDispatch(ledger, engine), 1); assert.equal(claimEngineDispatch(ledger, engine), 2);
    assert.throws(() => claimEngineDispatch(ledger, { ...engine, maxDispatches: 25 }), /leaves 23 dispatches beyond the 2 already used/);
    assert.equal(JSON.parse(readFileSync(ledger, "utf8")).max, 22);
    assert.equal(claimEngineDispatch(ledger, { ...engine, maxDispatches: 24 }), 3);
    assert.throws(() => claimEngineDispatch(ledger, { ...engine, model: "another-model", maxDispatches: 24 }), /different engine/);
    writeReceipt(ledger, { engine: {}, max: 3, used: "corrupt", allocations: [] });
    assert.throws(() => claimEngineDispatch(ledger, engine), /invalid/);
  } finally { f.close(); }
});

test("admission takes a cumulative ceiling above 40 and only safe absolute prior evidence roots", () => {
  const f = fixture();
  try {
    const priorRoot = join(f.root, "prior-evidence"); mkdirSync(priorRoot);
    const admitted = admitEngineDescriptor({ ...f.descriptor, maxDispatches: 41, priorEvidence: [priorRoot] }, f);
    assert.equal(admitted.ok, true);
    if (admitted.ok) { assert.equal(admitted.descriptor.maxDispatches, 41); assert.deepEqual(admitted.descriptor.priorEvidence, [priorRoot]); }
    assert.equal(admitEngineDescriptor({ ...f.descriptor, maxDispatches: 21 }, f).ok, false);
    assert.equal(admitEngineDescriptor({ ...f.descriptor, maxDispatches: 22.5 }, f).ok, false);
    for (const priorEvidence of [["relative/receipts"], [join(f.root, "absent")], [join(f.home, ".murage")], [join(f.repoRoot, "evidence")], "not-an-array"]) {
      assert.equal(admitEngineDescriptor({ ...f.descriptor, priorEvidence }, f).ok, false, JSON.stringify(priorEvidence));
    }
  } finally { f.close(); }
});

test("owner decides every card except the scenario's own controlled denial; the runner never grants", () => {
  const f = fixture();
  try {
    // Offline owner/engine stand-ins: the operation is a real file write;
    // this does not claim the product approval HTTP route or a model ran.
    const path = join(f.root, "brief.md");
    type Card = { tool?: string; title?: string; subtitle?: string };
    const execute = (id: (typeof B08_CASES)[number]["id"], card: Card, ownerDecision?: "allow" | "deny") => {
      if (approvalPolicy(id, card) === "deny") return "denied";
      if (!ownerDecision) return "pending-owner";
      if (ownerDecision === "deny") return "denied";
      writeFileSync(path, "# Synthetic approved brief\n", { flag: "wx" });
      return "allowed-once";
    };
    const write: Card = { tool: "edit", title: "Write outputs/brief.md" };
    const memory: Card = { tool: "murage-memory__memory_search", title: "Search memory" };
    const probe: Card = { tool: "shell", subtitle: "whoami; id; ls" };
    assert.equal(execute("cowork/supplied-data", write), "pending-owner"); assert.equal(existsSync(path), false);
    assert.equal(execute("cowork/denied-access", { tool: "shell", subtitle: "chmod 600 sources/pilot-source.md" }, "allow"), "denied"); assert.equal(existsSync(path), false);
    assert.equal(execute("cowork/supplied-data", write, "deny"), "denied");
    assert.equal(execute("cowork/supplied-data", write, "allow"), "allowed-once");
    assert.equal(readFileSync(path, "utf8"), "# Synthetic approved brief\n");
    // Scenarios whose controlled state is not an approval denial auto-deny nothing.
    for (const item of B08_CASES.filter((c) => c.scenario !== "denied-access")) {
      for (const card of [write, memory, probe]) assert.equal(approvalPolicy(item.id, card), "owner-once", `${item.id} ${card.tool}`);
      assert.match(approvalRule(item.id), /^every approval card waits for the owner's one-time decision/);
    }
    // cowork/missing-capability: an owner allow-once must reach the read-only filesystem.
    assert.equal(approvalPolicy("cowork/missing-capability", write), "owner-once");
    assert.equal(approvalPolicy("personal-assistant/denied-access", { tool: "calendar__read_calendar", title: "read_calendar" }), "deny");
    assert.equal(approvalPolicy("personal-assistant/denied-access", memory), "owner-once");
    assert.equal(approvalPolicy("murage-guide/denied-access", { tool: "shell", subtitle: "sed -i s/key/x/ config.json" }), "deny");
    assert.equal(approvalPolicy("murage-guide/denied-access", memory), "owner-once");
    assert.equal(approvalPolicy("cowork/denied-access", probe), "owner-once");
    for (const item of B08_CASES.filter((c) => c.scenario === "denied-access")) assert.match(approvalRule(item.id), /denied by the runner\b[^;]*; every other approval card waits/);
  } finally { f.close(); }
});

test("heuristic failure remains data and dependent-case runner has no soft assertions", () => {
  const rubric = evaluateRubric("absent commitment", B08_CASES[0]!.rubric);
  assert.equal(rubric.screened, false);
  const source = readFileSync(new URL("./b08-template-behavior.human.spec.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /expect\.soft/);
  assert.match(source, /carried\.set\("personal-assistant", \{ threadId \}\);\s+screen\(run/);
  // Flagged heuristics stay visible data in the status the spec records.
  assert.match(source, /caseStatus\(\{ dispatches: run\.dispatches, [^}]*\bflagged\b/);
  assert.match(caseStatus({ dispatches: 1, flagged: 1, endedAfterDenial: 0 }), /1 heuristic screen\(s\) flagged for assessment$/);
});

test("retained artifact bytes survive source removal and cannot be overwritten", () => {
  const f = fixture();
  try {
    const source = join(f.root, "brief.md"); writeFileSync(source, "# Original\n");
    const retained = retainArtifact(join(f.root, "evidence"), "cowork/supplied-data", "first", readFileSync(source));
    writeFileSync(source, "# Revised\n");
    const revised = retainArtifact(join(f.root, "evidence"), "cowork/second-turn", "second", readFileSync(source));
    unlinkSync(source);
    assert.equal(readFileSync(retained, "utf8"), "# Original\n"); assert.equal(readFileSync(revised, "utf8"), "# Revised\n");
    assert.throws(() => retainArtifact(join(f.root, "evidence"), "cowork/supplied-data", "first", Buffer.from("changed")), /changed bytes/);
  } finally { f.close(); }
});

test("task identity refuses per-task model drift and Auto/remembered grants", () => {
  const f = fixture();
  try {
    const task = { modelSelection: { instanceId: f.descriptor.instanceId, model: f.descriptor.model }, lastInstanceId: f.descriptor.instanceId, autoApprove: false, alwaysAllow: [] };
    assert.deepEqual(taskIdentityProblems(task, f.descriptor), []);
    assert.equal(taskIdentityProblems({ ...task, modelSelection: { ...task.modelSelection, model: "other" } }, f.descriptor).length, 1);
    assert.equal(taskIdentityProblems({ ...task, autoApprove: true }, f.descriptor).length, 1);
    assert.equal(taskIdentityProblems({ ...task, alwaysAllow: ["Bash"] }, f.descriptor).length, 1);
    assert.equal(taskIdentityProblems(undefined, f.descriptor).length, 2);
  } finally { f.close(); }
});

test("every unexecuted case is labelled NOT RUN from dispatch evidence, not from error wording", () => {
  assert.match(caseStatus({ dispatches: 0, error: "NOT RUN: depends on cowork/supplied-data, which published no brief", flagged: 0, endedAfterDenial: 0 }), /^NOT RUN: depends on cowork\/supplied-data/);
  assert.match(caseStatus({ dispatches: 0, error: "PATCH /api/mcp/servers/calendar → 500: boom", flagged: 0, endedAfterDenial: 0 }), /^NOT RUN: PATCH [^]*500: boom$/);
  assert.match(caseStatus({ dispatches: 0, flagged: 0, endedAfterDenial: 0 }), /^NOT RUN: the case ended before any dispatch$/);
  assert.match(unexecutedStatus(), /^NOT RUN: /);
  assert.equal(caseStatus({ dispatches: 1, flagged: 0, endedAfterDenial: 0 }), B08_DONE);
  assert.equal(caseStatus({ dispatches: 2, error: "boom", flagged: 0, endedAfterDenial: 0 }), "failed: boom");
  assert.match(caseStatus({ dispatches: 1, error: "NOT ESTABLISHED: no owner decision arrived for 1 approval card(s) (r1) within 600000 ms; turn interrupted, not resent", flagged: 0, endedAfterDenial: 0 }), /^NOT ESTABLISHED: no owner decision arrived/);
  assert.match(caseStatus({ dispatches: 1, flagged: 1, endedAfterDenial: 1 }), /1 heuristic screen\(s\) flagged for assessment; verdict hint: NOT ESTABLISHED — the engine ended 1 turn\(s\) after a denied tool/);
  const source = readFileSync(new URL("./b08-template-behavior.human.spec.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /did not run/);
  assert.match(source, /\?\? unexecutedStatus\(\)/);
  assert.match(source, /caseStatus\(\{ dispatches: run\.dispatches/);
  assert.match(source, /run\.dispatches \+= 1/);
});

test("engine stop reasons come from native ACP logs, classify an engine-ended denial, and export with a manifest", () => {
  const f = fixture();
  try {
    const data = join(f.root, "data"), native = join(data, "native");
    mkdirSync(native, { recursive: true });
    const t0 = Date.parse("2026-09-14T10:24:40.000Z");
    const lines = [
      { at: "2026-09-14T10:24:41.043Z", dir: "in", source: "fuigo.acp", msg: { jsonrpc: "2.0", id: 0, method: "session/request_permission", params: { toolCall: { kind: "edit", title: "Write outputs/brief.md" } } } },
      { at: "2026-09-14T10:24:41.408Z", dir: "in", source: "fuigo.acp", msg: { jsonrpc: "2.0", method: "_fuigo/session/prompt_complete", params: { promptId: "p1", stopReason: "cancelled", cancellationCategory: "PermissionRejected", cancellationContext: { tool_name: "write" } } } },
      { at: "2026-09-14T10:24:41.412Z", dir: "in", source: "fuigo.acp", msg: { jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled", _meta: { promptId: "p1" } } } },
      { at: "2026-09-14T10:30:00.000Z", dir: "in", source: "fuigo.acp", msg: { jsonrpc: "2.0", id: 9, result: { stopReason: "end_turn", _meta: { promptId: "p2" } } } },
    ];
    writeFileSync(join(native, "s1.ndjson"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot json but mentions stopReason\n`, { mode: 0o600 });
    const stops = nativeStops(data, t0, t0 + 5_000);
    assert.deepEqual(stops, [{ at: "2026-09-14T10:24:41.412Z", stopReason: "cancelled", cancellationCategory: "PermissionRejected", tool: "write", promptId: "p1" }]);
    const later = nativeStops(data, t0 + 300_000, t0 + 400_000);
    assert.deepEqual(later.map((stop) => stop.stopReason), ["end_turn"]);
    const turn = (over: Partial<{ interrupted: boolean; endedAfterDenial: boolean; engineStops: EngineStop[] }>) => ({ interrupted: false, endedAfterDenial: false, engineStops: [], ...over });
    assert.equal(endedByEngineAfterDenial(turn({ engineStops: stops })), true);
    assert.equal(endedByEngineAfterDenial(turn({ endedAfterDenial: true })), true);
    assert.equal(endedByEngineAfterDenial(turn({ engineStops: stops, interrupted: true })), false);
    assert.equal(endedByEngineAfterDenial(turn({ engineStops: later })), false);
    assert.deepEqual(nativeStops(join(f.root, "absent"), 0, Date.now()), []);
    const exported = exportNativeLogs(data, join(f.root, "evidence"), "cowork/denied-access", t0);
    assert.equal(exported.length, 1);
    assert.equal(readFileSync(exported[0]!.file, "utf8"), readFileSync(join(native, "s1.ndjson"), "utf8"));
    assert.equal(statSync(exported[0]!.file).mode & 0o077, 0);
    safeWipeSync(data);
    const manifest = JSON.parse(readFileSync(join(f.root, "evidence", "native", "cowork__denied-access", "MANIFEST.json"), "utf8"));
    assert.equal(manifest.files[0].sha256, exported[0]!.sha256);
    assert.equal(readFileSync(exported[0]!.file, "utf8").includes("PermissionRejected"), true);
    assert.deepEqual(exportNativeLogs(data, join(f.root, "evidence"), "cowork/denied-access", t0), []);
  } finally { f.close(); }
});

test("bounded cleanup confirms success or reports unconfirmed close", async () => {
  await boundedClose(async () => undefined, 100);
  await assert.rejects(boundedClose(() => new Promise(() => undefined), 10), /close not confirmed/);
});

test("empty explicit fleet closes server and preserves data while tracked child is alive", { timeout: 120_000 }, async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: { HOME: f.home, PATH: "/usr/bin:/bin" } });
  let harness: Awaited<ReturnType<typeof startIsolatedHarness>> | undefined;
  let confirmed = false;
  try {
    assert.ok(child.pid);
    harness = await startIsolatedHarness({ repoRoot: fileURLToPath(new URL("../../", import.meta.url)), parent: f.root, evidenceDir: join(f.root, "logs"), instances: {} });
    harness.trackOwnedChild(child.pid);
    const first = await harness.close();
    assert.equal(first.pidsGone, false); assert.equal(first.dataDirRemoved, false);
    assert.equal(existsSync(harness.dataDir), true);
    await waitForExit(child, { signal: "SIGTERM", graceMs: 2_000 });
    const final = await harness.close();
    assert.equal(final.pidsGone, true); assert.equal(final.dataDirRemoved, false);
    console.log(JSON.stringify({ evidence: "empty-fleet lifecycle", serverPids: harness.pids, childPid: child.pid, dataDir: harness.dataDir, first, final, credentialUsed: false, engineInstances: 0 }));
    confirmed = true;
  } finally {
    await waitForExit(child, { signal: "SIGTERM", graceMs: 2_000 });
    const cleanup = await harness?.close();
    if (confirmed || !harness || cleanup?.pidsGone) f.close();
  }
});


test("readonly Cowork fixture prepares pinned native metadata before denying artifact writes", () => {
  const f = fixture(), botId = "readonly-bot", threadId = "readonly-task";
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  writeFileSync(join(f.root, "bots.json"), JSON.stringify([{ id: botId, threadId, playbooks: [], tasks: [{ threadId, resumeCursors: {}, busy: false }] }]));
  writeFileSync(join(f.root, "groups.json"), "[]");
  const skillText = ["---", "name: readonly-check", "description: Offline metadata fixture", "---", "Preserve owner text.", ""].join("\n");
  const setup = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { installSkill, setSkillEnabled } from ${JSON.stringify(new URL("../../server/skills.ts", import.meta.url).href)};
    const result = installSkill("readonly-bot", "offline-fixture", [{ path: "SKILL.md", content: ${JSON.stringify(skillText)} }]);
    if ("error" in result) throw Error(result.error);
    const enabled = setSkillEnabled("readonly-bot", result.name, true);
    if ("error" in enabled || !enabled.enabled) throw Error("synthetic skill enable failed");
  `], { cwd: repoRoot, env: { HOME: f.home, USERPROFILE: f.home, MURAGE_DATA_DIR: f.root }, encoding: "utf8", timeout: 20_000 });
  let frozen: ReturnType<typeof prepareReadOnlyTaskWorkspace> | undefined;
  try {
    assert.equal(setup.status, 0, setup.stderr);
    frozen = prepareReadOnlyTaskWorkspace({ repoRoot, dataDir: f.root, home: f.home, botId, threadId });
    assert.equal(frozen.nativeMetadataReady, true);
    assert.equal(frozen.writesDenied, true);
    assert(frozen.filesBefore.some(item => item.path.includes(".murage-procedures") && item.path.endsWith(".complete")));
    assert(frozen.filesBefore.some(item => item.path === ".agents/skills/readonly-check" && item.value.startsWith("link:")));
    for (const directory of [frozen.workspace, frozen.outputs]) assert.throws(() => writeFileSync(join(directory, "brief.md"), "must not be saved"), /EACCES|EPERM|EROFS/);
    frozen.assertUnchanged();
    // A model cannot hide a changed metadata file behind a path-only comparison.
    const note = frozen.filesBefore.find(item => item.path.endsWith("skills/readonly-check/SKILL.md") && !item.value.startsWith("link:"))!;
    const full = join(frozen.workspace, note.path);
    chmodSync(full, 0o600); writeFileSync(full, "changed");
    assert.throws(() => frozen!.assertUnchanged(), /files or pinned metadata changed/);
    frozen.restore(); frozen = undefined;
    writeFileSync(join(f.root, "workspaces", botId, "threads", threadId, "outputs", "after-cleanup.md"), "restored");
  } finally { frozen?.restore(); f.close(); }
});

test("readonly Cowork fixture refuses busy or resumed tasks before freezing or claiming", () => {
  const f = fixture(), repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  try {
    for (const task of [{ threadId: "task", busy: true, resumeCursors: {} }, { threadId: "task", busy: false, resumeCursors: { engine: "existing-session" } }]) {
      writeFileSync(join(f.root, "bots.json"), JSON.stringify([{ id: "bot", threadId: "task", tasks: [task] }]));
      assert.throws(() => prepareReadOnlyTaskWorkspace({ repoRoot, dataDir: f.root, home: f.home, botId: "bot", threadId: "task" }), /requires an idle owned task|requires a fresh task/);
      assert.equal(existsSync(join(f.root, "workspaces", "bot", "threads", "task")), false);
    }
  } finally { f.close(); }
});
