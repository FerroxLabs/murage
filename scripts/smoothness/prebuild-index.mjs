// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lstatSync, realpathSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

// Import the PRODUCT schema, not the rig's schema. Its registrations are the
// authority, including interpolated SQL and indexes added after this rig shipped.
export async function preListenIndexes(productRoot) {
  const memory = join(resolve(productRoot), "server", "memory");
  await import(pathToFileURL(join(memory, "schema.ts")).href);
  const { OPTIONAL_INDEXES, REQUIRED_INDEXES = [] } = await import(pathToFileURL(join(memory, "optional-index.ts")).href);
  if (!Array.isArray(OPTIONAL_INDEXES) || !Array.isArray(REQUIRED_INDEXES)) throw Error("product index registry is unavailable");
  const indexes = [...REQUIRED_INDEXES, ...OPTIONAL_INDEXES].filter(index => index.preListen);
  const names = new Set();
  for (const index of indexes) {
    if (!index.name || !index.table || !index.sql || names.has(index.name)) {
      throw Error("invalid product preListen index registration");
    }
    names.add(index.name);
  }
  return indexes;
}

export function verifyIndexes(db, indexes) {
  const query = db.prepare("SELECT tbl_name, sql FROM sqlite_schema WHERE type='index' AND name=?");
  for (const index of indexes) {
    const actual = query.get(index.name);
    if (!actual) throw Error(`missing preListen index: ${index.name}`);
    if (actual.tbl_name !== index.table || actual.sql !== index.sql.replace(" IF NOT EXISTS", "")) {
      throw Error(`incorrect preListen index definition: ${index.name}`);
    }
  }
  return indexes.map(index => index.name);
}

export function buildIndexes(db, indexes) {
  const built = [];
  for (const index of indexes) {
    const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(index.name);
    try { db.exec(index.sql); }
    catch (error) { throw Error(`cannot build preListen index ${index.name}: ${error.message}`); }
    if (!exists) built.push(index.name);
  }
  return { found: indexes.map(index => index.name), built, verified: verifyIndexes(db, indexes) };
}

export function schemaVersion(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_meta'").get()) return 0;
  return Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version);
}

function verifySchemaVersion(db, schema, indexes) {
  const version = schemaVersion(db);
  if (version !== schema.MEMORY_SCHEMA_VERSION || indexes.some(index => version < index.minSchemaVersion)) {
    throw Error(`incorrect memory schema version: ${version}; expected ${schema.MEMORY_SCHEMA_VERSION}`);
  }
  return version;
}

// Validate every path before SQLite opens anything. Snapshot names and the
// partial suffix come from the selected product, just like its migration does.
export function containedDatabase(file, schema) {
  const absolute = resolve(file), dir = dirname(absolute);
  if (realpathSync(dirname(file)) !== dir) throw Error("database directory contains a symlink");
  if (lstatSync(file).isSymbolicLink()) throw Error("database is a symlink");
  const canonical = realpathSync(file);
  if (dirname(canonical) !== dir || !lstatSync(canonical).isFile()) throw Error("fixture/run database is not a contained file");
  const snapshots = [schema.MEMORY_PRE_V2_SNAPSHOT, schema.MEMORY_PRE_V3_SNAPSHOT, schema.MEMORY_PRE_V4_SNAPSHOT];
  if (snapshots.some(name => typeof name !== "string") || typeof schema.MEMORY_SNAPSHOT_PARTIAL_SUFFIX !== "string") {
    throw Error("product snapshot path contract is unavailable");
  }
  const targets = [canonical, ...snapshots.flatMap(name => {
    const path = join(dir, name); // exactly the target passed to product migration
    return [path, `${path}${schema.MEMORY_SNAPSHOT_PARTIAL_SUFFIX}`];
  })];
  for (const target of targets) for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const path = `${target}${suffix}`;
    if (dirname(path) !== dir) throw Error(`snapshot or sidecar escapes database directory: ${path}`);
    let entry;
    try { entry = lstatSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    // lstat also catches dangling links that existsSync would overlook.
    if (entry && (entry.isSymbolicLink() || realpathSync(path) !== path || !entry.isFile())) {
      throw Error(`snapshot or sidecar is not a contained regular file: ${path}`);
    }
  }
  return canonical;
}

// database.ts:287-301,330,342 (product 375f8e0c5): existing-file boot settings and
// migration options. Only connection PRAGMAs live here; all schema/migration SQL
// and snapshot handling belong to the selected PRODUCT's callable migration.
export async function migrateProductMemory(db, productRoot, file, schema) {
  const server = join(resolve(productRoot), "server");
  const { DEFAULT_BUSY_MS } = await import(pathToFileURL(join(server, "db-busy.ts")).href);
  const { JOURNAL_SIZE_LIMIT_BYTES } = await import(pathToFileURL(join(server, "database.ts")).href);
  if (typeof schema.migrateMemorySchema !== "function" || !Number.isInteger(DEFAULT_BUSY_MS) ||
      !Number.isInteger(JOURNAL_SIZE_LIMIT_BYTES)) throw Error("product memory migration/connection contract is unavailable");
  db.exec(`PRAGMA busy_timeout=${DEFAULT_BUSY_MS}`);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
  db.exec(`PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES}; PRAGMA wal_autocheckpoint=1000;`);
  db.exec("PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;");
  const migrating = schemaVersion(db) !== 0 && schemaVersion(db) !== schema.MEMORY_SCHEMA_VERSION;
  if (migrating) db.exec("PRAGMA cache_size=-524288");
  const dir = dirname(resolve(file));
  try {
    schema.migrateMemorySchema(db, "off", {
      snapshotPath: join(dir, schema.MEMORY_PRE_V2_SNAPSHOT),
      snapshotV2Path: join(dir, schema.MEMORY_PRE_V3_SNAPSHOT),
      snapshotV3Path: join(dir, schema.MEMORY_PRE_V4_SNAPSHOT),
    });
    if (migrating) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { if (migrating) db.exec("PRAGMA cache_size=-32768"); }
}

export async function main(args) {
  const [mode, productRoot, fileArg] = args;
  if (!["--list", "--build", "--verify"].includes(mode) || !productRoot ||
      (mode === "--list" ? args.length !== 2 : args.length !== 3)) {
    throw Error("usage: prebuild-index.mjs --list PRODUCT | --build PRODUCT DB | --verify PRODUCT DB");
  }
  const indexes = await preListenIndexes(productRoot);
  if (mode === "--list") return { found: indexes.map(index => index.name) };
  // Never create an empty database because the launcher supplied the wrong path.
  const schema = await import(pathToFileURL(join(resolve(productRoot), "server/memory/schema.ts")).href);
  const file = containedDatabase(fileArg, schema);
  const { DEFAULT_BUSY_MS } = await import(pathToFileURL(join(resolve(productRoot), "server/db-busy.ts")).href);
  if (!Number.isInteger(DEFAULT_BUSY_MS)) throw Error("product connection contract is unavailable");
  const db = new DatabaseSync(file, { readOnly: mode === "--verify" });
  let before;
  try {
    db.exec(`PRAGMA busy_timeout=${DEFAULT_BUSY_MS}`);
    before = schemaVersion(db);
    console.error(JSON.stringify({ mode, schemaVersionBefore: before, expectedSchemaVersion: schema.MEMORY_SCHEMA_VERSION }));
    const began = performance.now();
    if (mode === "--build") await migrateProductMemory(db, productRoot, file, schema);
    const migrationMs = performance.now() - began;
    const after = verifySchemaVersion(db, schema, indexes);
    const indexStart = performance.now();
    const result = mode === "--build" ? buildIndexes(db, indexes) : { verified: verifyIndexes(db, indexes) };
    return { ...result, schemaVersionBefore: before, schemaVersionAfter: after, migrationMs, indexMs: performance.now() - indexStart };
  } finally {
    try { console.error(JSON.stringify({ mode, schemaVersionBefore: before, schemaVersionAfter: schemaVersion(db) })); }
    finally { db.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch (error) { console.error(`PREBUILD FAILED: ${error.message}`); process.exitCode = 4; }
}
