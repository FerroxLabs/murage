import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { waitForExit } from "../../server/testing/cleanup.ts";
import {
  B08_CASES, admitEngineDescriptor, approvalPolicy, boundedClose, canonicalPath, claimRunDispatch,
  evaluateRubric, readCredential, retainArtifact, runEvidenceDir, startIsolatedHarness, taskIdentityProblems, writeReceipt,
  type B08EngineDescriptor,
} from "./b08-template-behavior-fixture.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "b08-correction-offline-"));
  const home = join(root, "synthetic-home"), repoRoot = join(root, "synthetic-repo");
  mkdirSync(home); mkdirSync(repoRoot);
  const descriptor: B08EngineDescriptor = { instanceId: "dedicated", driver: "openai-compat", displayName: "Dedicated local model", model: "local-model", account: "synthetic-account", config: {}, spend: { paid: false, reason: "offline admission only" }, maxDispatches: 24 };
  return { root, home, repoRoot, descriptor, close: () => rmSync(root, { recursive: true, force: true }) };
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

test("same evidence override isolates two runs and preserves same-run dispatch cap", () => {
  const f = fixture();
  try {
    const override = join(f.root, "evidence"), a = runEvidenceDir(f.root, override, "run-a"), b = runEvidenceDir(f.root, override, "run-b");
    assert.notEqual(a, b);
    assert.equal(claimRunDispatch(a, 2), 1); assert.equal(claimRunDispatch(a, 2), 2);
    assert.throws(() => claimRunDispatch(a, 2), /budget/);
    assert.equal(claimRunDispatch(b, 2), 1);
    writeReceipt(join(a, "SUMMARY.json"), { stale: true });
    writeReceipt(join(a, "calendar-receipt.jsonl"), { stale: true });
    assert.equal(existsSync(join(b, "SUMMARY.json")), false);
    assert.equal(existsSync(join(b, "calendar-receipt.jsonl")), false);
    assert.throws(() => runEvidenceDir(f.root, override, "../escape"), /stamp/);
    assert.throws(() => claimRunDispatch(a, 3), /changed/);
    writeReceipt(join(b, "dispatch-budget.json"), { max: 2, used: "corrupt" });
    assert.throws(() => claimRunDispatch(b, 2), /invalid/);
  } finally { f.close(); }
});

test("positive Cowork waits for owner once: permitted synthetic write and distinct denial", () => {
  const f = fixture();
  try {
    // Offline owner/engine stand-ins: the operation is a real file write;
    // this does not claim the product approval HTTP route or a model ran.
    const path = join(f.root, "brief.md");
    const execute = (id: (typeof B08_CASES)[number]["id"], ownerDecision?: "allow" | "deny") => {
      if (approvalPolicy(id) === "deny") return "denied";
      if (!ownerDecision) return "pending-owner";
      if (ownerDecision === "deny") return "denied";
      writeFileSync(path, "# Synthetic approved brief\n", { flag: "wx" });
      return "allowed-once";
    };
    assert.equal(execute("cowork/supplied-data"), "pending-owner"); assert.equal(existsSync(path), false);
    assert.equal(execute("cowork/denied-access", "allow"), "denied"); assert.equal(existsSync(path), false);
    assert.equal(execute("cowork/supplied-data", "deny"), "denied");
    assert.equal(execute("cowork/supplied-data", "allow"), "allowed-once");
    assert.equal(readFileSync(path, "utf8"), "# Synthetic approved brief\n");
    for (const item of B08_CASES.filter((c) => c.scenario === "denied-access")) assert.equal(approvalPolicy(item.id), "deny");
    assert.equal(approvalPolicy("cowork/second-turn"), "owner-once");
    assert.equal(approvalPolicy("cowork/interruption-restart"), "owner-once");
  } finally { f.close(); }
});

test("heuristic failure remains data and dependent-case runner has no soft assertions", () => {
  const rubric = evaluateRubric("absent commitment", B08_CASES[0]!.rubric);
  assert.equal(rubric.screened, false);
  const source = readFileSync(new URL("./b08-template-behavior.human.spec.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /expect\.soft/);
  assert.match(source, /carried\.set\("personal-assistant", \{ threadId \}\);\s+screen\(run/);
  assert.match(source, /flagged for assessment/);
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
