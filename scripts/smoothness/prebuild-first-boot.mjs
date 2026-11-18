// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only in an isolated test container. Launches the documented verification
// fixture with a synthetic pre-v13 database and fake engines; never a live app.
import assert from "node:assert/strict";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { preListenIndexes, verifyIndexes, schemaVersion } from "./prebuild-index.mjs";

const [productArg, evidenceArg] = process.argv.slice(2);
if (!productArg || !evidenceArg) throw Error("usage: prebuild-first-boot.mjs PRODUCT EVIDENCE");
const product = resolve(productArg), evidence = resolve(evidenceArg);
mkdirSync(evidence, { recursive: true });
const moduleUrl = file => pathToFileURL(join(product, file)).href;
const { launchVerificationServer, runControlMurage } = await import(moduleUrl("scripts/control-murage.ts"));
const seedUrl = new URL("./prebuild-fixture.mjs", import.meta.url).href;
const indexes = await preListenIndexes(product);
for (const version of [12, 13]) {
  let fixture;
  const began = performance.now();
  try {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      import { join } from 'node:path';
      import { writeFileSync } from 'node:fs';
      import { performance } from 'node:perf_hooks';
      import { seedPrebuildFixture } from ${JSON.stringify(seedUrl)};
      const seed = await seedPrebuildFixture(${JSON.stringify(product)}, join(process.env.MURAGE_DATA_DIR, 'messages.db'), ${version});
      process.env.MURAGE_TURN_TRACE = '1';
      writeFileSync(join(process.env.MURAGE_DATA_DIR, 'first-boot.json'), JSON.stringify({ PREBUILD: 0, ...seed, seedFinishedMs: performance.now() }));
      // Normal server/index.ts boot owns the first database() call and listen.
    ` });
    const launchMsIncludingSeed = performance.now() - began;
    const result = JSON.parse(readFileSync(join(fixture.info.dataDir, "first-boot.json"), "utf8"));
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      result.schemaVersionAfter = schemaVersion(db);
      result.sourceStampsAfter = Number(db.prepare("SELECT count(*) n FROM memory_source_lsn").get().n);
      result.verified = verifyIndexes(db, indexes);
    } finally { db.close(); }
    const log = readFileSync(fixture.info.logPath, "utf8");
    const marks = Object.fromEntries([...log.matchAll(/phase=startup\.(\S+) ms=(\d+)/g)].map(match => [match[1], Number(match[2])]));
    assert.ok(Number.isFinite(marks["database.begin"]) && Number.isFinite(marks["database.open"]) && Number.isFinite(marks.listen), "real boot timing marks required");
    result.databaseOpenMs = marks["database.open"] - marks["database.begin"];
    result.databaseBeginToListenMs = marks.listen - marks["database.begin"];
    result.seedEndToListenMs = marks.listen - result.seedFinishedMs;
    assert.equal(result.schemaVersion, version);
    assert.equal(result.schemaVersionAfter, 13);
    const doctor = await runControlMurage(["doctor", "--url", fixture.info.url], { env: { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir } });
    writeFileSync(join(evidence, `doctor-v${version}.json`), JSON.stringify(doctor, null, 2));
    const health = await (await fetch(`${fixture.info.url}/api/health`)).json();
    writeFileSync(join(evidence, `health-v${version}.json`), JSON.stringify(health, null, 2));
    assert.equal(health.pid, fixture.info.pid);
    const info = { ...result, launchMsIncludingSeed, fixture: fixture.info };
    writeFileSync(join(evidence, `first-boot-v${version}.json`), JSON.stringify(info, null, 2));
    console.log(JSON.stringify(info));
  } finally {
    if (fixture) {
      const log = fixture.info.logPath;
      await fixture.stop();
      copyFileSync(log, join(evidence, `server-v${version}.log`));
      await fixture.close();
    }
  }
}
