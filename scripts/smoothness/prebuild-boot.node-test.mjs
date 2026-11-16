// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run in a network-none container. All databases and homes are disposable.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const cli = fileURLToPath(new URL("./prebuild-index.mjs", import.meta.url));
const seedUrl = new URL("./prebuild-fixture.mjs", import.meta.url).href;
const quote = name => `"${name.replaceAll('"', '""')}"`;
const hash = text => createHash("sha256").update(text).digest("hex");

function inventory(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // rootpage describes physical placement, not schema. Keep every other
    // sqlite_master field, including SQLite's autoindexes and FTS shadow tables.
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const tables = {};
    for (const { name } of schema.filter(row => row.type === "table")) {
      const statement = db.prepare(`SELECT * FROM ${quote(name)}`);
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      const rows = statement.all().map(row => JSON.stringify(row.map(value =>
        typeof value === "bigint" ? ["integer", String(value)] :
        value instanceof Uint8Array ? ["blob", Buffer.from(value).toString("hex")] :
        [typeof value, value]))).sort();
      tables[name] = { count: rows.length, sha256: hash(JSON.stringify(rows)) };
    }
    return { schema, schemaSha256: hash(JSON.stringify(schema)), tables };
  } finally { db.close(); }
}

function tableRows(file, name) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(`SELECT * FROM ${quote(name)}`).all(); }
  finally { db.close(); }
}

// Exceptions are narrow, checked against the selected product's source and
// actual differing values. Never normalize these away from the hash evidence.
async function explainDifferences(product, version, differences, prebuildFile, bootFile) {
  const ref = (file, needle) => {
    const lines = readFileSync(join(product, file), "utf8").split("\n");
    const line = lines.findIndex(text => text.includes(needle));
    assert.notEqual(line, -1, `product explanation no longer exists: ${file}: ${needle}`);
    return { file, line: line + 1, text: lines[line].trim() };
  };
  const url = file => pathToFileURL(join(product, file)).href;
  await import(url("server/memory/schema.ts"));
  await import(url("server/message-id-index.ts"));
  await import(url("server/transcript-seq.ts"));
  const { OPTIONAL_INDEXES } = await import(url("server/memory/optional-index.ts"));
  const eager = new Set(["memory_details_identity", "memory_records_canon", "memory_records_waiting_review", "memory_tombstones_forgets"]);
  const appTables = {
    flux_capture_hold: "server/message-tables.ts",
    project_routine_authority: "server/project-tables.ts",
  };
  for (const diff of differences) {
    if (version !== 12) continue; // current-version fixture must match exactly
    if (diff.kind === "schema" && diff.prebuild === null) {
      const object = diff.boot;
      const index = OPTIONAL_INDEXES.find(index => index.name === object.name);
      if (object.type === "index" && index && object.tbl_name === index.table && object.sql === index.sql.replace(" IF NOT EXISTS", "")) {
        if (eager.has(index.name) && index.eager) diff.explanation = {
          reason: "Product builds eager indexes on a migrating boot; prebuild builds only preListen indexes.",
          source: [ref("server/database.ts", "try { buildEagerIndexesBeforeListen(db"), ref("server/memory/optional-index.ts", "return buildBeforeListen(db, index => Boolean(index.eager)")],
        };
        else if (["messages_id", "messages_thread_seq"].includes(index.name)) {
          assert.deepEqual(tableRows(bootFile, "messages"), []);
          diff.explanation = {
            reason: "Product message initialization rebuilds this index immediately on the fixture's empty messages table.",
            source: [ref("server/message-tables.ts", index.name === "messages_id" ? "if (!messageIdIndexReady(db)) db.exec" : "if (!seqIndexReady(db)) db.exec")],
          };
        }
      } else if (object.type === "table" && appTables[object.name]) {
        const file = appTables[object.name];
        assert.ok(readFileSync(join(product, file), "utf8").includes(object.sql.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")));
        assert.deepEqual(tableRows(bootFile, object.name), []);
        diff.explanation = {
          reason: "Product downgrade removed this app table; product boot recreates it empty outside memory migration.",
          source: [ref(file, `CREATE TABLE IF NOT EXISTS ${object.name}`), ref("server/memory/upgrade-app-tables.ts", `"${object.name}"`)],
        };
      } else if (object.name === "sqlite_autoindex_project_routine_authority_1" && object.type === "index" && object.tbl_name === "project_routine_authority" && object.sql === null) {
        diff.explanation = {
          reason: "SQLite creates the primary-key autoindex with the boot-only project_routine_authority table.",
          source: [ref("server/project-tables.ts", "CREATE TABLE IF NOT EXISTS project_routine_authority"), ref("server/project-tables.ts", "request_id TEXT PRIMARY KEY REFERENCES room_requests")],
        };
      }
    } else if (diff.kind === "table" && diff.prebuild === null && appTables[diff.name] && diff.boot.count === 0) {
      diff.explanation = {
        reason: "Absent before prebuild; boot creates this empty app table (full DDL difference listed separately).",
        source: [ref(appTables[diff.name], `CREATE TABLE IF NOT EXISTS ${diff.name}`)],
      };
    } else if (diff.kind === "table" && ["app_write_revision", "upgrade_integrity_pass"].includes(diff.name)) {
      const left = tableRows(prebuildFile, diff.name), right = tableRows(bootFile, diff.name);
      diff.rows = { prebuild: left, boot: right };
      assert.equal(left.length, 1); assert.equal(right.length, 1);
      const field = diff.name === "app_write_revision" ? "epoch" : "started_at";
      const omit = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== field));
      assert.deepEqual(omit(left[0]), omit(right[0]), `only ${field} may differ in ${diff.name}`);
      if (field === "epoch") {
        for (const row of [...left, ...right]) assert.match(row.epoch, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
        diff.explanation = {
          reason: "Migrating product boot invalidates cached counts with a fresh random epoch; prebuild does not run that app bookkeeping.",
          source: [ref("server/database.ts", "if (migrating) { try { bumpWriteEpoch(db)"), ref("server/app-write-revision.ts", "SET epoch=?,n=0 WHERE id=1")],
        };
      } else {
        for (const row of [...left, ...right]) assert.ok(Number.isSafeInteger(row.started_at) && row.started_at > 0);
        diff.explanation = {
          reason: "Both migrations start the identical integrity pass using their own wall-clock timestamp; every other column matches.",
          source: [ref("server/memory/schema.ts", "beginIntegrityPass(db);"), ref("server/memory/integrity-state.ts", "now = Date.now()")],
        };
      }
    }
  }
}

function child(dir, source) {
  mkdirSync(dir, { recursive: true });
  const home = join(dir, "home");
  mkdirSync(home);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 120_000,
    env: { ...process.env, HOME: home, MURAGE_DATA_DIR: dir },
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

for (const productArg of process.env.PREBUILD_TEST_PRODUCTS?.split(":") ?? ["."]) {
  const product = resolve(productArg);
  const url = file => pathToFileURL(join(product, file)).href;
  for (const version of [12, 13]) test(`one product boot vs prebuild: ${product} v${version}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rigpre4-boot-"));
    try {
      const seed = join(root, "seed"), prebuild = join(root, "prebuild"), boot = join(root, "boot");
      const logs = {};
      // An existing installation has app tables as well as memory tables.
      // Initialize those through the product, then downgrade the memory fixture
      // and remove preListen indexes to model an install before this release.
      logs.seed = child(seed, `
        import { seedPrebuildFixture } from ${JSON.stringify(seedUrl)};
        await seedPrebuildFixture(${JSON.stringify(product)}, ${JSON.stringify(join(seed, "messages.db"))}, 13);
        const { database, closeDatabase } = await import(${JSON.stringify(url("server/database.ts"))});
        const db = database();
        const schema = await import(${JSON.stringify(url("server/memory/schema.ts"))});
        if (${version} !== schema.MEMORY_SCHEMA_VERSION) schema.downgradeMemorySchema(db, ${version});
        const { OPTIONAL_INDEXES, REQUIRED_INDEXES = [] } = await import(${JSON.stringify(url("server/memory/optional-index.ts"))});
        for (const index of [...REQUIRED_INDEXES, ...OPTIONAL_INDEXES].filter(index => index.preListen)) db.exec('DROP INDEX IF EXISTS "' + index.name + '"');
        db.exec("DELETE FROM memory_scope_bindings WHERE id='memory-shape-check'");
        closeDatabase();
      `);
      for (const dir of [prebuild, boot]) {
        mkdirSync(dir);
        copyFileSync(join(seed, "messages.db"), join(dir, "messages.db"));
      }
      const before = inventory(join(seed, "messages.db"));
      assert.equal(tableRows(join(seed, "messages.db"), "memory_meta")[0].schema_version, version);
      assert.equal(before.tables.memory_records.count, 10_000);
      assert.equal(before.tables.memory_source_versions.count, 10_000);
      assert.deepEqual(inventory(join(prebuild, "messages.db")), before);
      assert.deepEqual(inventory(join(boot, "messages.db")), before);
      logs.prebuild = child(prebuild, `
        import { main } from ${JSON.stringify(pathToFileURL(cli).href)};
        console.log(JSON.stringify(await main(["--build", ${JSON.stringify(product)}, ${JSON.stringify(join(prebuild, "messages.db"))}])));
      `);
      logs.boot = child(boot, `
        const { database, closeDatabase } = await import(${JSON.stringify(url("server/database.ts"))});
        database();
        closeDatabase();
      `);
      const actual = inventory(join(prebuild, "messages.db"));
      const expected = inventory(join(boot, "messages.db"));
      assert.equal(tableRows(join(prebuild, "messages.db"), "memory_meta")[0].schema_version, 13);
      assert.equal(tableRows(join(boot, "messages.db"), "memory_meta")[0].schema_version, 13);
      assert.notEqual(actual.tables.memory_scope_bindings.sha256, before.tables.memory_scope_bindings.sha256,
        "exercise the validation marker write flagged in review, including on v13");
      const differences = [];
      const objects = new Set([...actual.schema, ...expected.schema].map(row => `${row.type}:${row.name}`));
      for (const key of objects) {
        const left = actual.schema.find(row => `${row.type}:${row.name}` === key) ?? null;
        const right = expected.schema.find(row => `${row.type}:${row.name}` === key) ?? null;
        if (JSON.stringify(left) !== JSON.stringify(right)) differences.push({ kind: "schema", name: key, prebuild: left, boot: right });
      }
      for (const name of new Set([...Object.keys(actual.tables), ...Object.keys(expected.tables)])) {
        const left = actual.tables[name] ?? null, right = expected.tables[name] ?? null;
        if (JSON.stringify(left) !== JSON.stringify(right)) differences.push({ kind: "table", name, prebuild: left, boot: right });
      }
      await explainDifferences(product, version, differences, join(prebuild, "messages.db"), join(boot, "messages.db"));
      const unexplained = differences.filter(diff => !diff.explanation);
      const report = { product, version, before, prebuild: actual, boot: expected, differences, unexplained, logs };
      if (process.env.PREBUILD_TEST_EVIDENCE) {
        mkdirSync(process.env.PREBUILD_TEST_EVIDENCE, { recursive: true });
        writeFileSync(join(process.env.PREBUILD_TEST_EVIDENCE, `${basename(product)}-boot-v${version}.json`), JSON.stringify(report, null, 2));
      }
      console.log(JSON.stringify({ product, version, tables: Object.keys(expected.tables).length, differences }));
      assert.deepEqual(unexplained, [], "every boot/prebuild difference requires a product-line explanation");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
