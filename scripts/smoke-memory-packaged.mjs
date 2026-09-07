// P06/P11 focused worker proof. Does not launch the app or access a live profile.
// Usage: node scripts/smoke-memory-packaged.mjs --resources /absolute/Resources
// Optional: --model-directory /absolute/model --runtime /absolute/Electron
// Build-stage alternative: --server-directory /absolute/dist-server --runtime /absolute/runtime
// --runtime is explicit for staged Resources; the report identifies that limit.
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const inside = (root, path) => { const tail = relative(root, path); return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); };

async function probe(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const { DatabaseSync } = await import("node:sqlite");
  const schemaPath = [join(config.server, "server/memory/schema.js"), join(config.server, "memory/schema.js")].find(existsSync);
  assert(schemaPath, "Packaged authoritative schema module missing; fixture cannot substitute a handwritten schema");
  const { migrateMemorySchema, validateMemorySchema } = await import(pathToFileURL(schemaPath).href);
  const authorityPath = join(config.root, "authority.db");
  const indexPath = join(config.root, "index.db");
  const authority = new DatabaseSync(authorityPath);
  const records = [
    { id: "gold", version: 1, scopeId: "allowed", text: "Orchidneedle. The vehicle needs gasoline to travel.", deleted: false },
    { id: "denied", version: 1, scopeId: "denied", text: "Orchidneedle car fuel. This private material must never be retrieved.", deleted: false },
    { id: "deleted-source", version: 1, scopeId: "allowed", text: "Orchidneedle car fuel. This source has been deleted.", deleted: false },
  ];
  try {
    authority.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    migrateMemorySchema(authority);
    authority.exec("BEGIN IMMEDIATE");
    for (const scope of ["allowed", "denied"]) {
      authority.prepare("INSERT INTO memory_scopes(id,kind,owner_key,audience,revision) VALUES(?,'bot',?,'[]',0)").run(scope, scope);
    }
    for (const record of records) {
      const hash = createHash("sha256").update(record.text).digest("hex");
      authority.prepare("INSERT INTO memory_sources(id,scope_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,?,1,?,'text','owner','completed',?)")
        .run(record.id, record.scopeId, hash, record.id === "deleted-source" ? "deleted" : "active");
      authority.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,?,?,1)")
        .run(record.id, hash, JSON.stringify({ text: record.text }));
      authority.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'statement',?,'owner-statement','active',1,1)")
        .run(record.id, record.scopeId, record.text);
      authority.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,?)")
        .run(record.id, record.id, Buffer.byteLength(record.text));
    }
    authority.exec("COMMIT");
    assert(validateMemorySchema(authority).size > 0, "Authoritative schema validation collected no tables");
  } finally { authority.close(); }

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
  // On the harness deadline, reap the task-owned worker before the parent removes its fixture.
  const terminate = async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      await new Promise(done => { worker.once("exit", done); worker.kill("SIGKILL"); });
    }
    process.exit(1);
  };
  process.once("SIGTERM", terminate);

  function start() {
    const child = fork(workerPath, [], { cwd: config.root, execPath: process.execPath, execArgv: [], env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const mailbox = [];
    let wake;
    child.on("message", message => { mailbox.push(message); wake?.(); });
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
        if (Date.now() >= deadline) throw Error(`Worker timed out waiting for ${type}\n${workerOutput}`);
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
  async function stop() {
    const child = worker;
    if (!child) return;
    assert(child.exitCode === null && child.signalCode === null, "Worker exited before disconnect");
    const exited = new Promise((done, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("Worker failed graceful disconnect deadline")); }, 10000);
      child.once("exit", (code, signal) => { clearTimeout(timer); code === 0 && signal === null ? done() : reject(Error(`Worker exit ${code}/${signal}`)); });
    });
    child.disconnect();
    await exited;
    worker = undefined;
  }
  async function query(text, semantic) {
    const requestId = `query-${++sequence}`;
    worker.send({ type: "query", requestId, input: { query: text, scopeIds: ["allowed"], policyRevision: 0, deletionEpoch: 0, historical: false, cursor: "", limit: 20, semantic } });
    const { result } = await worker.wait("query-result", requestId);
    assert(!result.degradedReason, `Query degraded: ${result.degradedReason}`);
    assert.deepEqual(result.hits.map(hit => hit.id), ["gold"], "Missing gold or leaked denied/deleted source");
    return result;
  }
  try {
    assert.equal((await initialize()).reset, true);
    checks.push("worker-ready-and-authoritative-schema");
    worker.send({ type: "index", requestId: "index", records });
    const indexed = await worker.wait("index-result", "index");
    assert.equal(indexed.embeddingStatus, "indexed", "Real pinned offline model inference failed");
    assert.equal(indexed.records.length, records.length);
    checks.push("pinned-model-offline-inference");
    await query("Orchidneedle", false);
    checks.push("lexical-hit-and-denied-source-exclusion");
    // No lexical term occurs in the eligible source; a hit needs independent semantic candidates.
    const semantic = await query("car fuel", true);
    assert.equal(semantic.vectorRows, 1, "Denied/deleted sources participated in similarity ranking");
    assert.equal(semantic.coverageComplete, true);
    assert(Number.isFinite(semantic.hits[0].similarity) && semantic.hits[0].similarity > 0);
    checks.push("independent-semantic-hit-and-denied-source-exclusion");
    await stop();
    assert.equal((await initialize()).reset, false, "Restart discarded retained index");
    await query("Orchidneedle", false);
    await stop();
    checks.push("graceful-disconnect-and-retained-index-restart");
    console.log(JSON.stringify({ ok: true, checks, node: process.version, electron: process.versions.electron ?? null, platform: process.platform, arch: process.arch,
      model: `${manifest.model}@${manifest.revision}`, runtimeVersion: actualPackage.version, schemaSha256: digest(schemaPath), workerSha256: digest(workerPath),
      modelManifestSha256: digest(join(config.server, "memory-model-manifest.json")), runtimeManifestSha256: digest(join(config.server, "memory-runtime-manifest.json")),
      workerPeakRssBytes: semantic.workerPeakRssBytes, limitation: "Focused worker smoke; not full-service latency, UI, MCP, restore or cross-platform proof" }));
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      await new Promise(done => { worker.once("exit", done); worker.kill("SIGKILL"); });
    }
    process.removeListener("SIGTERM", terminate);
  }
}

async function main() {
  if (args.includes("--probe")) return probe(option("--probe"));
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
    writeFileSync(config, JSON.stringify({ root, server, model }), { mode: 0o600 });
    const env = { HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root, ELECTRON_RUN_AS_NODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", NODE_PATH: "", XDG_CACHE_HOME: join(home, "cache"), XDG_CONFIG_HOME: join(home, "config") };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
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
    console.log(JSON.stringify({ ...result, resources, serverSource, artifact: resources ? "packaged-resources" : "build-stage", runtime: realpathSync(runtime), runtimeOverride: Boolean(runtimeArgument), isolatedCopy: true }));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(done => { child.once("exit", done); child.kill("SIGKILL"); });
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
