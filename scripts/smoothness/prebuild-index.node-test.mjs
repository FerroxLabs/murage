import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { preListenIndexes, buildIndexes, verifyIndexes, schemaVersion } from "./prebuild-index.mjs";
import { seedPrebuildFixture } from "./prebuild-fixture.mjs";

const cli = fileURLToPath(new URL("./prebuild-index.mjs", import.meta.url));
const guard = fileURLToPath(new URL("./prebuild-before-listen.sh", import.meta.url));
const keeper = fileURLToPath(new URL("./keep-logs.sh", import.meta.url));
const products = process.env.PREBUILD_TEST_PRODUCTS?.split(":") ?? [resolve(".")];
for (const product of products) {
  for (const startingVersion of [12, 13]) test(`preListen fixture: ${product} v${startingVersion}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rigpre1-"));
    const file = join(root, "fixture.db");
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    const indexes = await preListenIndexes(product);
    const schema = await import(pathToFileURL(join(resolve(product), "server/memory/schema.ts")).href);
    // schema.ts also loads app-table modules that register their own preListen indexes (messages_turn).
    const messages = await import(pathToFileURL(join(resolve(product), "server/message-tables.ts")).href);
    const declared = [...Object.values(schema), ...Object.values(messages)].filter(value => value?.preListen && typeof value.sql === "string");
    assert.deepEqual(indexes.map(index => index.name).sort(), declared.map(index => index.name).sort(),
      "discover every exported preListen registration, not only the first");
    let db;
    try {
      const seed = await seedPrebuildFixture(product, file, startingVersion);
      db = new DatabaseSync(file);
      assert.equal(schemaVersion(db), startingVersion);
      if (startingVersion === 12) assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_source_lsn'").get(), undefined);
      assert.ok(indexes.length > 0, "regression fixtures must exercise indexes");
      for (const index of indexes) db.exec(`DROP INDEX IF EXISTS "${index.name}"`);
      const listed = run("--list", product);
      assert.equal(listed.status, 0, listed.stderr);
      assert.deepEqual(JSON.parse(listed.stdout).found, indexes.map(index => index.name));
      const missing = run("--verify", product, file);
      assert.equal(missing.status, 4);
      assert.match(missing.stderr, /PREBUILD FAILED: (missing preListen index|incorrect memory schema version)/);
      const built = run("--build", product, file);
      assert.equal(built.status, 0, built.stderr);
      const result = JSON.parse(built.stdout);
      assert.equal(result.schemaVersionBefore, startingVersion);
      assert.equal(result.schemaVersionAfter, schema.MEMORY_SCHEMA_VERSION);
      assert.deepEqual(result.built, indexes.map(index => index.name));
      assert.deepEqual(result.verified, result.found);
      const verified = run("--verify", product, file);
      assert.equal(verified.status, 0, verified.stderr);
      console.log(JSON.stringify({ product, ...seed, ...result, beforeListenVerified: JSON.parse(verified.stdout).verified }));
      assert.equal(Number(db.prepare("SELECT count(*) n FROM memory_source_lsn").get().n), startingVersion === 12 ? 0 : seed.sourceVersions,
        "v13 creates stamps empty, without backfilling old sources");
      assert.deepEqual(buildIndexes(db, indexes).built, [], "idempotent restart");
      const sentinel = join(root, "listened");
      const out = join(root, "out"), logs = join(root, "logs");
      const rigNode = join(root, "rig-node"), nodeCalls = join(root, "node-calls");
      const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
      writeFileSync(rigNode, `#!/bin/bash\nprintf '%s\\n' "$1" >> ${quote(nodeCalls)}\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
      mkdirSync(out);
      writeFileSync(join(out, "server-fixture.log"), "fixture log\n");
      const launch = (node = rigNode) => spawnSync("bash", [guard, product, file, process.execPath, "--input-type=module", "-e", `
        import { writeFileSync } from 'node:fs';
        import { spawnSync } from 'node:child_process';
        import assert from 'node:assert/strict';
        writeFileSync(${JSON.stringify(sentinel)}, 'before-listen verified');
        assert.equal(process.env.SMOOTH_NODE, ${JSON.stringify(rigNode)});
        const kept = spawnSync('bash', ${JSON.stringify([keeper, out, logs, "fixture"])}, { encoding: 'utf8' });
        assert.equal(kept.status, 0, kept.stderr);
      `], { encoding: "utf8", env: { ...process.env, SMOOTH_NODE: node } });
      const unavailable = launch(join(root, "missing-node"));
      assert.equal(unavailable.status, 4);
      assert.equal(existsSync(sentinel), false);
      // Exercise migration at the actual launch boundary too, not only the CLI.
      if (startingVersion === 12) schema.downgradeMemorySchema(db, 12);
      const launched = launch();
      assert.equal(launched.status, 0, launched.stderr);
      assert.match(launched.stdout, /PREBUILD=1/);
      assert.equal(readFileSync(sentinel, "utf8"), "before-listen verified");
      const prebuildLog = readFileSync(join(root, "prebuild.log"), "utf8");
      assert.ok(prebuildLog.includes(`"schemaVersionBefore":${startingVersion}`));
      assert.match(prebuildLog, /"schemaVersionAfter":13/);
      assert.ok(prebuildLog.includes(indexes.at(-1).name));
      if (process.env.PREBUILD_TEST_EVIDENCE) {
        const evidence = join(process.env.PREBUILD_TEST_EVIDENCE, `${basename(resolve(product))}-v${startingVersion}`);
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, "prebuild.log"), prebuildLog);
      }
      assert.equal(readFileSync(join(logs, "fixture", "server-fixture.log"), "utf8"), "fixture log\n");
      assert.ok(readFileSync(nodeCalls, "utf8").includes("keep-logs.mjs"), "keeper must use the rig Node, not the host default");
      rmSync(sentinel);
      const failingVerifyNode = join(root, "failing-verify-node");
      writeFileSync(failingVerifyNode, `#!/bin/bash\nif [ "$2" = --verify ]; then exit 4; fi\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
      assert.equal(launch(failingVerifyNode).status, 4);
      assert.equal(existsSync(sentinel), false, "failed separate verification must never start the command");
      // Losing any index must refuse the listen boundary, including the last one.
      for (const index of indexes) {
        db.exec(`DROP INDEX "${index.name}"`);
        assert.throws(() => verifyIndexes(db, indexes), new RegExp(`missing preListen index: ${index.name}`));
        assert.equal(run("--verify", product, file).status, 4);
        buildIndexes(db, indexes);
      }
      // IF NOT EXISTS cannot silently accept an unrelated index with the same name.
      const first = indexes[0];
      const column = db.prepare(`PRAGMA table_info("${first.table}")`).get()?.name;
      assert.equal(typeof column, "string", "the selected product index has a real table column");
      db.exec(`DROP INDEX "${first.name}"; CREATE INDEX "${first.name}" ON "${first.table}"("${column}" DESC)`);
      assert.throws(() => buildIndexes(db, indexes), /incorrect preListen index definition/);
      db.exec(`DROP INDEX "${first.name}"`);
      buildIndexes(db, indexes);
      const last = indexes.at(-1);
      db.exec("PRAGMA foreign_keys=OFF"); // deliberately corrupt a populated fixture
      db.exec(`DROP TABLE "${last.table}"`);
      const failed = run("--build", product, file);
      assert.equal(failed.status, 4);
      assert.match(failed.stderr, /PREBUILD FAILED:/, "product validation rejects malformed schemas before building");
      const refused = launch();
      assert.equal(refused.status, 4);
      assert.doesNotMatch(refused.stdout, /PREBUILD=1/);
      assert.equal(existsSync(sentinel), false, "failed prebuild must never start the server command");
      const absent = join(root, "absent.db");
      assert.equal(run("--build", product, absent).status, 4);
      assert.equal(existsSync(absent), false);
    } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
