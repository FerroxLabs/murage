import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline as copyStream } from "node:stream/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(repo, "shared/memory-model-manifest.json"), "utf8")) as {
  model: string; revision: string; dimensions: number; runtimeVersion: string;
  files: Array<{path: string; bytes: number; sha256: string}>;
};
const marker = ".murage-memory-qualification";
const args = process.argv.slice(2);
function value(flag: string) { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; }
async function hash(path: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
function ownedDestination(path: string, create: boolean) {
  if (!isAbsolute(path)) throw new Error("destination must be absolute");
  const dest = resolve(path);
  if ([repo, homedir(), tmpdir(), "/"].includes(dest) || dest.startsWith(join(homedir(), ".murage"))) throw new Error("refusing shared or live destination");
  for (let at = dest; at !== dirname(at); at = dirname(at)) if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error("symlink destination refused");
  if (!existsSync(dest)) { if (!create) throw new Error("model not prepared"); mkdirSync(dest, {recursive: true, mode: 0o700}); }
  if (!existsSync(join(dest, marker))) {
    if (!create || readdirSync(dest).length) throw new Error("destination is not task-owned");
    writeFileSync(join(dest, marker), manifest.revision, {mode: 0o600});
  }
  if (readFileSync(join(dest, marker), "utf8") !== manifest.revision) throw new Error("wrong model ownership revision");
  return dest;
}

async function prepare(dest: string) {
  for (const asset of manifest.files) {
    const target = join(dest, asset.path);
    mkdirSync(dirname(target), {recursive: true, mode: 0o700});
    if (existsSync(target) && statSync(target).size === asset.bytes && await hash(target) === asset.sha256) continue;
    const part = target + ".part";
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error("symlink partial refused");
    let offset = existsSync(part) ? statSync(part).size : 0;
    if (offset > asset.bytes) { rmSync(part); offset = 0; }
    if (offset < asset.bytes) {
      const response = await fetch(`https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${asset.path}`, {
        headers: offset ? {Range: `bytes=${offset}-`} : {}, signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok || !response.body) throw new Error(`asset download failed ${asset.path}: HTTP ${response.status}`);
      if (response.status === 206) {
        if (!response.headers.get("content-range")?.startsWith(`bytes ${offset}-`)) throw new Error("unexpected range response");
      } else offset = 0;
      await copyStream(Readable.fromWeb(response.body as never), createWriteStream(part, {flags: offset ? "a" : "w", mode: 0o600}));
    }
    if (statSync(part).size !== asset.bytes || await hash(part) !== asset.sha256) throw new Error(`asset integrity mismatch ${asset.path}`);
    renameSync(part, target);
    process.stderr.write(`Verified ${asset.path}\n`);
  }
}

async function sqliteProbe() {
  const root = mkdtempSync(join(tmpdir(), "murage-memory-sqlite-"));
  const db = new DatabaseSync(join(root, "probe.db"));
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE source(id TEXT PRIMARY KEY, body TEXT); CREATE TABLE job(id TEXT PRIMARY KEY); CREATE VIRTUAL TABLE search USING fts5(body, tokenize='unicode61');");
    db.exec("BEGIN IMMEDIATE; INSERT INTO source VALUES('rolled-back','not committed'); INSERT INTO job VALUES('rolled-back'); ROLLBACK;");
    if ((db.prepare("SELECT count(*) AS n FROM source").get() as {n: number}).n !== 0 || (db.prepare("SELECT count(*) AS n FROM job").get() as {n: number}).n !== 0) throw new Error("transaction rollback failed");
    db.exec("BEGIN IMMEDIATE; INSERT INTO source VALUES('gold','durable recovery checkpoint'); INSERT INTO job VALUES('gold'); INSERT INTO search VALUES('durable recovery checkpoint'); COMMIT;");
    if (!db.prepare("SELECT body FROM search WHERE search MATCH ?").get("recovery")) throw new Error("FTS5 required hit missing");
    await backup(db, join(root, "backup.db"));
    const restored = new DatabaseSync(join(root, "backup.db"), {readOnly: true});
    try { if (!(restored.prepare("SELECT id FROM job WHERE id='gold'").get())) throw new Error("backup lost committed outbox"); }
    finally { restored.close(); }
    return {node: process.version, platform: process.platform, arch: process.arch, sqlite: "PASS", fts5: "PASS", fullTransaction: "PASS", backup: "PASS"};
  } finally { db.close(); safeWipeSync(root); }
}

async function main() {
  if (args.includes("--sqlite-probe")) { console.log(JSON.stringify(await sqliteProbe())); return; }
  const dest = ownedDestination(value("--destination") ?? join(repo, ".planning/memory-evidence/model"), args.includes("--prepare-model"));
  if (args.includes("--prepare-model")) {
    if (!args.includes("--allow-download") || args.includes("--offline")) throw new Error("explicit --allow-download required");
    await prepare(dest);
    console.log(JSON.stringify({prepared: true, revision: manifest.revision, destination: dest})); return;
  }
  if (!args.includes("--offline")) throw new Error("qualification requires --offline");
  for (const file of manifest.files) {
    const path = join(dest, file.path);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || statSync(path).size !== file.bytes || await hash(path) !== file.sha256) throw new Error(`unverified model file ${file.path}`);
  }
  // Runtime may not download a model or silently fall back to a different artifact.
  const {env, pipeline} = await import("@huggingface/transformers");
  env.allowRemoteModels = false; env.allowLocalModels = true; env.useFSCache = false;
  const before = performance.now();
  const embed = await pipeline("feature-extraction", dest, {device: "cpu", dtype: "q8", local_files_only: true});
  try {
    const vectors = await embed(["The database backup runs nightly.", "ฐานข้อมูลสำรองทุกคืน", "数据库每晚备份。"], {pooling: "mean", normalize: true});
    const rows = vectors.tolist() as number[][];
    if (rows.length !== 3 || rows.some(row => row.length !== manifest.dimensions || row.some(v => !Number.isFinite(v)))) throw new Error("embedding dimensions or values invalid");
    const peakRssBytes = process.resourceUsage().maxRSS * 1024;
    const result = {...await sqliteProbe(), revision: manifest.revision, runtimeVersion: manifest.runtimeVersion, dimensions: rows[0].length, inferenceMs: performance.now() - before, peakRssBytes,
      memoryFeasibility: peakRssBytes <= 1024 ** 3 ? "PASS" : "FAIL", quality: "not measured; multilingual execution only"};
    console.log(JSON.stringify(result));
    if (result.memoryFeasibility !== "PASS") process.exitCode = 1;
  } finally { await embed.dispose(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
