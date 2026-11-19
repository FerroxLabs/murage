// P06/P11 focused worker proof. Does not launch the app or access a live profile.
// Usage: node scripts/smoke-memory-packaged.mjs --resources /absolute/Resources
// Optional: --model-directory /absolute/model --runtime /absolute/Electron
// Build-stage alternative: --server-directory /absolute/dist-server --runtime /absolute/runtime
// --runtime is explicit for staged Resources; the report identifies that limit.
// --backend wasm runs the worker on the packaged ONNX Runtime WebAssembly files even where the native binding
// loads (on Intel macOS that is the only executor, so the default run already proves it).
import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
function option(name) {
  const position = args.indexOf(name);
  if (position < 0) return undefined;
  const value = args[position + 1];
  if (!value || value.startsWith("--")) throw Error(`Missing ${name} value`);
  return value;
}
/** Runs of one message type collapse to "the type, then its first..last times, then a count" so a retry storm stays readable. */
const collapse = trail => {
  const runs = [];
  for (const entry of trail) {
    const [type, at] = entry.split("@"), last = runs.at(-1);
    if (last && last.type === type) { last.count++; last.last = at; } else runs.push({ type, first: at, last: at, count: 1 });
  }
  return runs.map(run => run.count === 1 ? `${run.type}@${run.first}` : `${run.type}@${run.first}..${run.last} x${run.count}`).join(", ");
};
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const inside = (root, path) => { const tail = relative(root, path); return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); };

/** The parent side of the helper's byte-admission protocol, answered the way server/memory/worker-controller.ts answers it.
 * Since background byte grants are enforced (b36bf61264) the worker writes its index only under a parent permit: with no
 * answer, MemoryIndex's first schema transaction is deferred (BG_DEFERRED) and retried forever without a word, so "initialised"
 * never comes (release rehearsals 44461021954 and 44537735532, macOS Intel). A smoke is the only writer: every request is
 * granted in full for the current minute, a charge is acknowledged, a drain hold is lifted, a final io report is acknowledged.
 * Returns true for a protocol message the caller must not treat as a reply. `settled` collects each permit's receipt. */
export function answerHelperProtocol(child, message, settled = []) {
  if (!message || typeof message !== "object") return false;
  if (message.type === "bg-grant-request") {
    const ceiling = Number(message.ceiling);
    const now = Date.now(), minute = Math.floor(now / 60000);
    const ticket = Number.isSafeInteger(ceiling) && ceiling >= 0
      ? { bytes: ceiling, debtBytes: 0, expiresAt: (minute + 1) * 60000, minute, cls: "BG", observed: 0, id: `smoke-permit-${settled.length}-${now}`, purpose: message.purpose === "owner-delete" ? "owner-delete" : "bg" }
      : null;
    child.send({ type: "bg-grant", ticket, retryInMs: 1000 });
    return true;
  }
  if (message.type === "bg-grant-settle") { settled.push({ id: message.id, used: Number(message.used) }); return true; }
  if (message.type === "charge") { child.send({ type: "charge-ack", helperRunId: message.helperRunId, fileId: message.fileId, attempt: message.attempt, granted: true }); return true; }
  if (message.type === "wal-drain") { child.send({ type: "wal-drain-ack", requestId: message.requestId }); return true; }
  if (message.final === true) child.send({ type: "io-final-ack", generation: message.generation, sequence: message.sequence });
  return message.type === "io";
}

/** The roster the smoke reads as: one reader bot in its direct thread, and another bot whose private thread it must never read. */
export const probeRoster = () => ({ memoryRosterRevision: 1, bots: [{ id: "reader", threadId: "direct" }, { id: "other", threadId: "private" }], groups: [] });

/** Seeds the authority the way the app holds it and issues the reader's recall view through the production builder.
 * Since the recall-view work the worker refuses a query that names no view (worker.ts serveQueries: RecallPreparationPending),
 * so a view-less smoke can never reach its first hit. `api` is the app's own modules (database.ts, memory/policy.ts,
 * memory/recall-view.ts, internal-capabilities.ts): the scopes come from ensureScope, the view from prepareRecallContextSync
 * (oracle, scopes, records, verify, publish), the capability from memoryAccess. No view, epoch or membership row is written here.
 * The records are fixture data: "gold" in the reader's own scope, "denied" in the other bot's private thread (outside the view),
 * "deleted-record" deleted the way production deletes (source and record state deleted, text scrubbed, indexed deleted:true:
 * memory-revocation.ts affect, worker-controller.ts) and "deleted-source" whose source is deleted while its record is still
 * active. That last state is real: memory-revocation.ts endSource ends the source and a later, budgeted expand step of the job
 * ends its records (affect), so a recall can run in between; it must never come back (recall-view-index.ts LIVE_VIEW_ROW).
 * The queries go through the app's own searchMemory (server/memory/search.ts: the helper's lists fused and every candidate
 * hydrated through readable.ts), with the packaged worker as its helper. */
export function seedRecallFixture(api) {
  const db = api.database();
  const roster = probeRoster();
  api.reconcileMemoryRoster(roster);
  api.setMemoryMode("active");
  const allowed = api.ensureScope("bot", "reader"), denied = api.ensureScope("conversation", "private");
  const records = [
    { id: "gold", version: 1, scopeId: allowed, text: "Orchidneedle. The vehicle needs gasoline to travel.", deleted: false },
    { id: "denied", version: 1, scopeId: denied, text: "Orchidneedle car fuel. This private material must never be retrieved.", deleted: false },
    { id: "deleted-source", version: 1, scopeId: allowed, text: "Orchidneedle car fuel. This source has been deleted.", deleted: false },
    { id: "deleted-record", version: 1, scopeId: allowed, text: "", deleted: true, wasText: "Orchidneedle car fuel. This record has been deleted." },
  ];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const record of records) {
      const text = record.wasText ?? record.text, hash = createHash("sha256").update(text).digest("hex");
      db.prepare("INSERT INTO memory_sources(id,scope_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,?,1,?,'text','owner','completed',?)")
        .run(record.id, record.scopeId, hash, record.id.startsWith("deleted-") ? "deleted" : "active");
      db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,?,?,1)")
        .run(record.id, hash, JSON.stringify({ text }));
      db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'statement',?,'owner-statement',?,1,1)")
        .run(record.id, record.scopeId, record.text, record.deleted ? "deleted" : "active");
      db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,?)")
        .run(record.id, record.id, Buffer.byteLength(text));
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  api.prepareRecallContextSync("reader", "direct", roster);
  api.stopRecallViewMaintenance();
  const registry = new api.InternalCapabilities();
  registry.begin("reader", "direct", "smoke-generation");
  const token = registry.mint({ botId: "reader", threadId: "direct", generation: "smoke-generation", depth: 0, kind: "memory", skillAuthoring: false });
  const access = api.memoryAccess(registry, registry.resolve(`Bearer ${token}`), () => roster);
  assert(access?.view?.viewId, "The production builder issued no recall view");
  assert.equal(api.recallViewHasScope(db, access.view, allowed), true, "The reader's view lacks its own scope");
  assert.equal(api.recallViewHasScope(db, access.view, denied), false, "The reader's view admits another bot's private thread");
  const reader = { botId: access.botId, threadId: access.threadId, humanPrincipal: access.humanPrincipal, notOwnerAudience: api.memoryAccessNotOwnerAudience(access) };
  return { db, records: records.map(({ wasText, ...record }) => record), allowed, denied, view: access.view, access };
}

async function probe(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const schemaPath = [config.schemaModule, join(config.server, "server/memory/schema.js"), join(config.server, "memory/schema.js")].filter(Boolean).find(existsSync);
  assert(schemaPath, "Packaged authoritative schema module missing; fixture cannot substitute a handwritten schema");
  // The app's own database opener migrates the authority; it reads MURAGE_DATA_DIR when the module loads.
  process.env.MURAGE_DATA_DIR = join(config.root, "data");
  mkdirSync(process.env.MURAGE_DATA_DIR, { recursive: true, mode: 0o700 });
  const api = await import(pathToFileURL(schemaPath).href);
  for (const name of ["database", "closeDatabase", "validateMemorySchema", "reconcileMemoryRoster", "setMemoryMode", "ensureScope", "prepareRecallContextSync", "stopRecallViewMaintenance", "InternalCapabilities", "memoryAccess", "memoryAccessNotOwnerAudience", "recallViewHasScope", "searchMemory", "clearMemorySearchCache", "LineageAllowance"]) {
    assert.equal(typeof api[name], "function", `Fixture module lacks the production ${name}`);
  }
  const { db, records, access } = seedRecallFixture(api);
  assert(api.validateMemorySchema(db).size > 0, "Authoritative schema validation collected no tables");
  const authorityPath = join(process.env.MURAGE_DATA_DIR, "messages.db");
  assert(existsSync(authorityPath), "The app database opener wrote no authority file");
  const indexPath = join(config.root, "index.db");

  const manifest = JSON.parse(readFileSync(join(config.server, "memory-model-manifest.json"), "utf8"));
  const runtimeManifest = JSON.parse(readFileSync(join(config.server, "memory-runtime-manifest.json"), "utf8"));
  assert.equal(runtimeManifest.platform, process.platform, "Staged runtime platform mismatch");
  assert.equal(runtimeManifest.arch, process.arch, "Staged runtime architecture mismatch");
  const runtime = runtimeManifest.packages.find(pkg => pkg.name === "@huggingface/transformers");
  assert(runtime && runtime.version === manifest.runtimeVersion, "Pinned runtime version mismatch");
  const actualPackage = JSON.parse(readFileSync(join(config.server, "node_modules/@huggingface/transformers/package.json"), "utf8"));
  assert.equal(actualPackage.version, manifest.runtimeVersion);
  const workerPath = join(config.server, "memory/worker.js");
  let worker;
  let workerOutput = "";
  let sequence = 0;
  const checks = [];
  const trail = [], settled = [];
  const progress = () => `Worker messages: ${trail.length ? collapse(trail) : "(none)"}`;
  // On the harness deadline, reap the task-owned worker before the parent removes its fixture.
  const terminate = async () => {
    console.error(`Probe hit the harness deadline after: ${checks.at(-1) ?? "no check"}\n${progress()}\nWorker output:\n${workerOutput || "(none)"}`);
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      await new Promise(done => { worker.once("exit", done); worker.kill("SIGKILL"); });
    }
    process.exit(1);
  };
  process.once("SIGTERM", terminate);

  function start() {
    const forkedAt = Date.now();
    const child = fork(workerPath, [], { cwd: config.root, execPath: process.execPath, execArgv: [], env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const mailbox = [];
    let wake;
    // Progress for a failure report: every message the worker sent, with the time since the probe forked it.
    child.on("message", message => {
      trail.push(`${message?.type ?? "?"}@${Date.now() - forkedAt}ms`);
      if (trail.length > 400) trail.splice(1, trail.length - 400);
      try { if (answerHelperProtocol(child, message, settled)) return; } catch (error) { mailbox.push({ type: "spawn-error", reason: `protocol answer failed: ${error.message}` }); }
      mailbox.push(message); wake?.();
    });
    child.on("exit", () => wake?.());
    child.on("error", error => { mailbox.push({ type: "spawn-error", reason: error.message }); wake?.(); });
    child.stdout.on("data", data => { workerOutput = (workerOutput + data).slice(-16000); });
    child.stderr.on("data", data => { workerOutput = (workerOutput + data).slice(-16000); });
    child.wait = async (type, requestId, timeout = 120000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const error = mailbox.find(message => ["error", "index-error", "spawn-error"].includes(message.type));
        if (error) throw Error(`Worker failure: ${JSON.stringify(error)}\n${workerOutput}`);
        const position = mailbox.findIndex(message => message.type === type && (!requestId || message.requestId === requestId));
        if (position >= 0) return mailbox.splice(position, 1)[0];
        if (child.exitCode !== null || child.signalCode !== null) throw Error(`Worker exited waiting for ${type}: ${child.exitCode}/${child.signalCode}\n${workerOutput}`);
        if (Date.now() >= deadline) throw Error(`Worker timed out waiting for ${type}\n${progress()}\n${workerOutput}`);
        await new Promise(done => {
          const timer = setTimeout(() => { wake = undefined; done(); }, Math.min(250, deadline - Date.now()));
          wake = () => { clearTimeout(timer); wake = undefined; done(); };
        });
      }
    };
    return child;
  }
  async function initialize() {
    worker = start();
    await worker.wait("ready");
    worker.send({ type: "init", indexPath, authorityPath, modelDirectory: config.model, manifest });
    return worker.wait("initialised");
  }
  /** What every thread of a held worker is doing (macOS only; the sample tool ships with the system). */
  function nativeStacks(pid) {
    if (process.platform !== "darwin") return "";
    const sampled = spawnSync("/usr/bin/sample", [String(pid), "2"], { encoding: "utf8", timeout: 8000 });
    return `\n${sampled.stdout ?? ""}`.slice(0, 16000);
  }
  async function stop() {
    const child = worker;
    if (!child) return;
    assert(child.exitCode === null && child.signalCode === null, `Worker exited before disconnect: ${child.exitCode}/${child.signalCode}\n${workerOutput}`);
    const exited = new Promise((done, reject) => {
      const timer = setTimeout(() => {
        const held = `still running${nativeStacks(child.pid)}`;
        child.kill("SIGKILL");
        reject(Error(`Worker failed graceful disconnect deadline: ${held}`));
      }, 10000);
      // Not "close": it never fires after the parent's own disconnect() (Node counts the IPC channel towards it and only a
      // channel the other side closed settles that count). The worker's last stderr lines arrive with its pipes' own close.
      const piped = Promise.all([child.stdout, child.stderr].map(stream => new Promise(ended => stream.once("close", ended))));
      child.once("exit", async (code, signal) => {
        clearTimeout(timer);
        await Promise.race([piped, new Promise(waited => setTimeout(waited, 2000))]);
        code === 0 && signal === null ? done() : reject(Error(`Worker exit ${code}/${signal}`));
      });
    });
    child.disconnect();
    await exited;
    worker = undefined;
  }
  // One recall, the app's way: searchMemory asks the packaged worker (its helper) with the input it builds itself (view, reader,
  // policy revision, deletion epoch, deadline), fuses the worker's lexical and vector lists and hydrates every candidate through
  // readable.ts. The answer must be exactly gold: no denied scope, no deleted record, no record of a deleted source.
  async function query(text) {
    let raw;
    const bridge = { async search(input) {
      const requestId = `query-${++sequence}`;
      worker.send({ type: "query", requestId, input });
      ({ result: raw } = await worker.wait("query-result", requestId));
      return raw;
    } };
    api.clearMemorySearchCache();
    const answer = await api.searchMemory(text, access, bridge, { allowance: api.LineageAllowance.tool(), caller: "tool" });
    assert(raw, "searchMemory never asked the packaged worker");
    assert(!raw.degradedReason, `Query degraded: ${raw.degradedReason}`);
    assert(!answer.degradedReason && !answer.partial, `Recall degraded: ${answer.degradedReason ?? "partial"}`);
    assert.deepEqual(answer.hits.map(hit => hit.id), ["gold"], "Missing gold or leaked denied/deleted source");
    return { raw, answer };
  }
  try {
    assert.equal((await initialize()).reset, true);
    checks.push("worker-ready-and-authoritative-schema");
    worker.send({ type: "index", requestId: "index", records });
    const indexed = await worker.wait("index-result", "index");
    assert.equal(indexed.embeddingStatus, "indexed", "Real pinned offline model inference failed");
    assert.equal(indexed.records.length, records.length);
    checks.push("pinned-model-offline-inference");
    const lexical = await query("Orchidneedle");
    // Deleted data is not even a candidate: the worker's word list over the view holds neither deleted case nor the denied scope.
    assert.deepEqual((lexical.raw.lexicalRanked ?? []).map(ref => ref[0]), ["gold"], "A denied or deleted record was a lexical candidate");
    checks.push("lexical-hit-and-denied-source-exclusion");
    // No lexical term occurs in the eligible source; a hit needs independent semantic candidates.
    const { raw: semantic } = await query("car fuel");
    assert.equal(semantic.vectorRows, 1, "Denied/deleted sources participated in similarity ranking");
    assert.deepEqual(semantic.unvectored ?? [], [], "An eligible source has no vector");
    assert.deepEqual(semantic.vectorRanked.map(ref => ref[0]), ["gold"], "A denied or deleted record was a vector candidate");
    assert(Number.isFinite(semantic.vectorRanked[0][2]) && semantic.vectorRanked[0][2] > 0);
    checks.push("independent-semantic-hit-and-denied-source-exclusion");
    await stop();
    const restarted = await initialize();
    assert.equal(restarted.reset, false, "Restart discarded retained index");
    // A WebAssembly helper is warmed before recall asks it, as the app does when a turn starts (worker-controller.ts warmForIntent ->
    // requestWarm): "warm", then "model-ready". The recall below still runs inside searchMemory's own budget and cutoff.
    if (restarted.wasm === true) { worker.send({ type: "warm" }); await worker.wait("model-ready"); }
    await query("Orchidneedle");
    await query("car fuel");
    await stop();
    checks.push("graceful-disconnect-and-retained-index-restart");
    console.log(JSON.stringify({ ok: true, checks, node: process.version, electron: process.versions.electron ?? null, platform: process.platform, arch: process.arch,
      model: `${manifest.model}@${manifest.revision}`, runtimeVersion: actualPackage.version, schemaSha256: digest(schemaPath), workerSha256: digest(workerPath),
      modelManifestSha256: digest(join(config.server, "memory-model-manifest.json")), runtimeManifestSha256: digest(join(config.server, "memory-runtime-manifest.json")),
      workerPeakRssBytes: semantic.workerPeakRssBytes, permits: settled.length, workerMessages: collapse(trail), limitation: "Focused worker smoke; not full-service latency, UI, MCP, restore or cross-platform proof" }));
  } catch (error) {
    // Every failure path, assertions and the disconnect deadline included: what the worker printed, and the last check it passed.
    console.error(`Probe failed after: ${checks.at(-1) ?? "no check"}\n${progress()}\nWorker output:\n${workerOutput || "(none)"}`);
    throw error;
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      await new Promise(done => { worker.once("exit", done); worker.kill("SIGKILL"); });
    }
    process.removeListener("SIGTERM", terminate);
    api.closeDatabase();
  }
}

/** The environment the probe (and through it the forked worker) runs with. The worker runs from a copy of server/ in a temporary
 * folder, so its dist-native fallback beside the module never exists: like the app's server (electron/harness-resources.mjs, which
 * server/memory/worker-controller.ts passes on to the worker), it finds engine-exclusion.node through MURAGE_RESOURCES_PATH, the
 * real packaged Resources. Without it the worker fails closed with BG_ENFORCEMENT_UNAVAILABLE. */
export function probeEnvironment({ root, home, resources, backend, systemRoot }) {
  const env = { HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root, ELECTRON_RUN_AS_NODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", NODE_PATH: "", XDG_CACHE_HOME: join(home, "cache"), XDG_CONFIG_HOME: join(home, "config") };
  if (systemRoot) env.SystemRoot = systemRoot;
  if (resources) env.MURAGE_RESOURCES_PATH = resources;
  if (backend === "wasm") env.MURAGE_MEMORY_BACKEND = "wasm";
  return env;
}

/** The fixture module: the app's own schema, database opener, policy and recall-view builder, bundled from this checkout. */
const FIXTURE_EXPORTS = [
  'export { migrateMemorySchema, validateMemorySchema } from "./server/memory/schema.ts";',
  'export { database, closeDatabase } from "./server/database.ts";',
  'export { ensureScope, memoryAccess, memoryAccessNotOwnerAudience, reconcileMemoryRoster } from "./server/memory/policy.ts";',
  'export { setMemoryMode } from "./server/memory/repository.ts";',
  'export { prepareRecallContextSync, recallViewHasScope, stopRecallViewMaintenance } from "./server/memory/recall-view.ts";',
  'export { InternalCapabilities } from "./server/internal-capabilities.ts";',
  'export { searchMemory, clearMemorySearchCache } from "./server/memory/search.ts";',
  'export { LineageAllowance } from "./server/memory/lineage-allowance.ts";',
].join(" ");

async function main() {
  if (args.includes("--probe")) return probe(option("--probe"));
  // Imported here, not at the top: the probe runs from a lone copy of this file, beside no checkout.
  const { safeWipeSync } = await import("../server/testing/safe-wipe.mjs");
  const resourceArgument = option("--resources"), serverArgument = option("--server-directory");
  assert(Boolean(resourceArgument) !== Boolean(serverArgument), "Supply exactly one of --resources or --server-directory");
  assert(isAbsolute(resourceArgument ?? serverArgument), "Resources/server directory must be absolute");
  const resources = resourceArgument ? realpathSync(resourceArgument) : null;
  const serverSource = serverArgument ? realpathSync(serverArgument) : join(resources, "server");
  for (const path of ["memory/worker.js", "memory-model-manifest.json", "memory-runtime-manifest.json", "node_modules/@huggingface/transformers/package.json"]) {
    assert(existsSync(join(serverSource, path)), `Missing packaged resource: server/${path}`);
  }
  const runtimeArgument = option("--runtime");
  const runtime = runtimeArgument ?? (resources && process.platform === "darwin" ? join(dirname(resources), "MacOS/Murage") : null);
  assert(runtime && isAbsolute(runtime) && existsSync(runtime), "Runtime missing; build-stage and non-macOS probes require explicit --runtime absolute executable");
  const modelArgument = option("--model-directory") ?? resolve(dirname(self), "../.planning/memory-evidence/model");
  assert(isAbsolute(modelArgument), "--model-directory must be absolute");
  const manifest = JSON.parse(readFileSync(join(serverSource, "memory-model-manifest.json"), "utf8"));
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, "Pinned manifest has no model assets");
  const root = mkdtempSync(join(tmpdir(), "murage-memory-packaged-"));
  let child;
  try {
    // Dereference package-manager links into the isolated copy; none can resolve back into the checkout.
    const server = join(root, "server");
    cpSync(serverSource, server, { recursive: true, dereference: true });
    // Fixture setup only: the authoritative memory schema, bundled from this checkout into one module, creates the
    // authority database. The tsc copy under server/server imports modules the server resources do not carry. The
    // worker under test is still the packaged, bundled one.
    // Built the way scripts/bundle-server.mjs builds the packaged server: schema.ts reaches the sentinel through
    // ../sqlite-open.ts, so CommonJS leaves read require/__filename/__dirname (banner), the Windows hide installer
    // stays external and relocatable (plugin), and drivers/murage-exec.ts reads its wrapper beside the bundle at load.
    const fixtureDir = join(root, "fixture-schema");
    const schemaModule = join(fixtureDir, "schema.mjs");
    const { build } = await import("esbuild");
    const { windowsHideBundlePlugin } = await import(pathToFileURL(join(dirname(self), "windows-hide-bundle-plugin.mjs")).href);
    const checkout = resolve(dirname(self), "..");
    await build({ stdin: { contents: FIXTURE_EXPORTS, resolveDir: checkout, loader: "ts" }, bundle: true, platform: "node", target: "node20", format: "esm", outfile: schemaModule, logLevel: "error",
      banner: { js: 'import { createRequire as __fixtureRequire } from "node:module"; import { fileURLToPath as __fixturePath } from "node:url"; import { dirname as __fixtureDir } from "node:path"; const require = __fixtureRequire(import.meta.url); const __filename = __fixturePath(import.meta.url); const __dirname = __fixtureDir(__filename);' },
      plugins: [windowsHideBundlePlugin()] });
    for (const sibling of ["murage-exec", "murage-exec.shapes"]) cpSync(join(checkout, "server/drivers", sibling), join(fixtureDir, sibling));
    const model = join(root, "model");
    for (const asset of manifest.files) {
      const source = resolve(modelArgument, asset.path), target = resolve(model, asset.path);
      assert(inside(resolve(modelArgument), source) && inside(model, target), "Unsafe model manifest path");
      const stat = lstatSync(source);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size === asset.bytes && digest(source) === asset.sha256, `Unverified model asset: ${asset.path}`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      cpSync(source, target);
    }
    const home = join(root, "home");
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(server, "package.json"), '{"type":"module"}\n');
    const runner = join(root, "probe.mjs"), config = join(root, "fixture.json");
    cpSync(self, runner);
    writeFileSync(config, JSON.stringify({ root, server, model, schemaModule }), { mode: 0o600 });
    const backend = option("--backend") ?? "auto";
    assert(["auto", "wasm"].includes(backend), "--backend must be auto or wasm");
    const env = probeEnvironment({ root, home, resources, backend, systemRoot: process.env.SystemRoot });
    child = spawn(runtime, [runner, "--probe", config], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout = (stdout + data).slice(-64000); });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-32000); });
    let forceTimer;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 10000);
    }, 300000);
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); }).finally(() => { clearTimeout(timer); clearTimeout(forceTimer); });
    assert.equal(code, 0, `Packaged memory probe failed: ${stderr}\n${stdout}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert(result.ok && result.checks.length === 5, "Probe returned no complete check set");
    console.log(JSON.stringify({ ...result, backend, fixtureSchema: "bundled-from-checkout", resources, serverSource, artifact: resources ? "packaged-resources" : "build-stage", runtime: realpathSync(runtime), runtimeOverride: Boolean(runtimeArgument), isolatedCopy: true }));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(done => { child.once("exit", done); child.kill("SIGKILL"); });
    }
    safeWipeSync(root, { maxRetries: 5, retryDelay: 200 });
  }
}
// Run only as a program (the probe copy runs itself too); a test imports probeEnvironment without starting a smoke.
const entry = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : ""; } catch { return ""; } })();
if (entry === realpathSync(self)) main().catch(error => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
