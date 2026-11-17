// SPDX-License-Identifier: AGPL-3.0-or-later
// Application meter owner: scperf-p1. Scanner meter owner: scperf-p2.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { ioMeterNativePath } from "./io-meter.ts";
import { prepareMemoryMeterFixture } from "./memory/testing/native-meter-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "meter-coexist-"));
let binary: string;
beforeAll(() => {
  prepareMemoryMeterFixture(root);
  binary = ioMeterNativePath()!;
  expect(binary).toEqual(expect.any(String));
});
afterAll(() => removeTempDirSync(root));

it.each(["scanner", "application"])("%s imports first: scanner receipts and checked writers use the same qualified native meter", first => {
  const appUrl = pathToFileURL(resolve("server/io-meter.ts")).href;
  const scannerUrl = pathToFileURL(resolve("server/sentinel/io-meter.ts")).href;
  const code = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { DatabaseSync } from 'node:sqlite';
    await import(${JSON.stringify(first === "scanner" ? scannerUrl : appUrl)});
    const app = await import(${JSON.stringify(appUrl)});
    const scanner = await import(${JSON.stringify(scannerUrl)});
    assert.equal(app.ensureIoMeter(), true);
    assert.equal(scanner.scannerIoSample().known, true);
    const db = new DatabaseSync(${JSON.stringify(join(root, `${first}.db`))});
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE evidence(value)');
    assert.equal(app.registerBg(db), true);
    app.registerBgProcess();
    const before = app.ioGrantSnapshot();
    app.withBgGrant({bytes: app.commitCeiling(8), expiresAt: Date.now() + 60000}, () => db.exec('INSERT INTO evidence VALUES(1)'), db);
    const after = app.ioGrantSnapshot();
    assert.equal(db.prepare('SELECT count(*) AS n FROM evidence').get().n, 1);
    assert.ok(after.usedBytes > 0);
    assert.equal(after.refusedWrites, before.refusedWrites);
    assert.equal(after.ceilingMiss, before.ceilingMiss);
    assert.equal(scanner.scannerNative(), createRequire(import.meta.url)(app.ioMeterNativePath()));
    db.close();
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", MURAGE_ENGINE_EXCLUSION_PATH: binary };
  delete env.MURAGE_RESOURCES_PATH; delete env.OMB_RESOURCES_PATH; delete env.MURAGE_PACKAGED;
  expect(() => execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { env, encoding: "utf8", stdio: "pipe" })).not.toThrow();
});
