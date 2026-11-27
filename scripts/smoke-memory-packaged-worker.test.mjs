// The packaged memory smoke drives the real worker with no controller. The worker asks its parent for byte permits before any
// background write (server/memory/helper-admission.ts), and a fresh index waits for its first admitted schema transaction before it
// says "initialised". A driver that never answers "bg-grant-request" leaves the worker retrying for good: release rehearsal 5,
// macOS Intel, "Worker timed out waiting for initialised" after "ready". This drives the real worker through the smoke's own driver.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { attemptProbeRecall, seedRecallFixture, startProbeWorker } from "./smoke-memory-packaged.mjs";
import { migrateMemorySchema } from "../server/memory/schema.ts";
import { DATA_DIR } from "../server/config.ts";
import { closeDatabase, database } from "../server/database.ts";
import { InternalCapabilities } from "../server/internal-capabilities.ts";
import { ensureScope, memoryAccess, memoryAccessNotOwnerAudience, reconcileMemoryRoster } from "../server/memory/policy.ts";
import { prepareRecallContextSync, recallViewHasScope, stopRecallViewMaintenance } from "../server/memory/recall-view.ts";
import { setMemoryMode } from "../server/memory/repository.ts";
import { clearMemorySearchCache, searchMemory } from "../server/memory/search.ts";
import { readableMemoryRecord } from "../server/memory/readable.ts";
import { LineageAllowance } from "../server/memory/lineage-allowance.ts";
import { BRANCH_TABLES_SQL } from "../server/branch-index.ts";
import { ioMeterNativePath } from "../server/io-meter.ts";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];
const workers = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) {
    if (worker.exitCode === null && worker.signalCode === null) await new Promise(done => { worker.once("exit", done); worker.kill("SIGKILL"); });
  }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});

async function initialize(root, authorityPath) {
  let output = "";
  // The packaged smoke finds this addon through MURAGE_RESOURCES_PATH; here the checkout's build is named directly.
  const env = { ...process.env, MURAGE_ENGINE_EXCLUSION_PATH: ioMeterNativePath(), HOME: root, TMPDIR: root };
  const init = { type: "init", indexPath: path.join(root, "index.db"), authorityPath, modelDirectory: path.join(root, "model"), manifest: { model: "fixture-model", revision: "fixture", files: [] } };
  const worker = startProbeWorker(path.join(checkout, "server/memory/worker.ts"), { cwd: root, env, execArgv: ["--experimental-strip-types", "--no-warnings"],
    onOutput: data => { output = (output + data).slice(-16000); }, output: () => output });
  workers.push(worker);
  await worker.wait("ready", undefined, 20000);
  worker.send(init);
  return { worker, initialised: await worker.wait("initialised", undefined, 30000), output: () => output };
}

async function stop(worker, output) {
  const exited = new Promise(done => worker.once("exit", (code, signal) => done({ code, signal })));
  worker.disconnect();
  expect(await exited, output()).toEqual({ code: 0, signal: null });
}

it("the smoke's driver brings the real worker from ready to initialised, and a restart keeps the index", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-worker-"));
  roots.push(root);
  const authorityPath = path.join(root, "authority.db");
  const authority = new DatabaseSync(authorityPath);
  try {
    authority.exec("PRAGMA journal_mode=WAL;");
    migrateMemorySchema(authority);
    authority.exec(BRANCH_TABLES_SQL);
  } finally { authority.close(); }
  const first = await initialize(root, authorityPath);
  expect(first.initialised.reset, first.output()).toBe(true);
  await stop(first.worker, first.output);
  const second = await initialize(root, authorityPath);
  expect(second.initialised.reset, "a restart discarded the retained index").toBe(false);
  await stop(second.worker, second.output);
}, 120000);

it("the packaged smoke's lexical query uses real recall authority and excludes denied and deleted sources", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-recall-"));
  roots.push(root);
  const fixture = { database, ensureScope, reconcileMemoryRoster, setMemoryMode, prepareRecallContextSync,
    stopRecallViewMaintenance, recallViewHasScope, InternalCapabilities, memoryAccess, memoryAccessNotOwnerAudience,
    clearMemorySearchCache, searchMemory, LineageAllowance };
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const { access } = seedRecallFixture(fixture);
    const { worker, initialised, output } = await initialize(root, path.join(DATA_DIR, "messages.db"));
    expect(initialised.reset, output()).toBe(true);
    const { raw, answer } = await attemptProbeRecall(worker, fixture, access, () => "lexical", "Orchidneedle");
    expect(raw?.lexicalRanked?.map(([id]) => id), "Missing gold or leaked a denied or deleted lexical candidate").toEqual(["gold"]);
    expect(answer.hits.map(hit => hit.id), "Missing gold or leaked denied or deleted evidence").toEqual(["gold"]);
    const options = { allowance: LineageAllowance.tool(), discovery: true };
    expect(typeof readableMemoryRecord("gold", 1, access, options)).not.toBe("string");
    expect(typeof readableMemoryRecord("deleted-source", 1, access, options), "The production reader disclosed deleted evidence").toBe("string");
    await stop(worker, output);
  } finally {
    stopRecallViewMaintenance();
    closeDatabase();
  }
}, 120000);
