// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

// Observe successful serving-thread statements, without altering admission,
// worker scheduling, or the reset protocol. The launcher owns all data.
const instrumentationSource = `
import { DatabaseSync } from "node:sqlite";
process.env.MURAGE_TURN_TRACE = "1";
const pendingReset = new WeakSet();
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  const reset = /INSERT INTO search_intents.*VALUES\\(\\?,0\\)/.test(sql);
  const prune = /^DELETE FROM search_intents WHERE seq < \\?/.test(sql);
  if (reset || prune) {
    const db = this, run = statement.run;
    statement.run = function(...args) {
      const result = run.apply(this, args);
      if (reset) pendingReset.add(db);
      console.log("[search-startup-test] " + (reset ? "reset-intent" : "idle-prune"));
      return result;
    };
  }
  return statement;
};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  const result = exec.call(this, sql);
  if (sql === "COMMIT" && pendingReset.delete(this)) console.log("[search-startup-test] reset-commit");
  return result;
};
`;

it.skipIf(process.platform === "win32")("search reset intent commits after first health and idle pruning follows it", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  try {
    const deadline = Date.now() + 20_000;
    let log = "";
    do {
      log = readFileSync(fixture.info.logPath, "utf8");
      if (log.includes("[search-startup-test] idle-prune")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    const health = log.indexOf("phase=startup.health.answered ");
    const reset = log.indexOf("[search-startup-test] reset-intent");
    const commit = log.indexOf("[search-startup-test] reset-commit");
    const prune = log.indexOf("[search-startup-test] idle-prune");
    expect(health, log).toBeGreaterThan(-1);
    expect(reset, log).toBeGreaterThan(health);
    expect(commit, log).toBeGreaterThan(reset);
    expect(prune, log).toBeGreaterThan(commit);
    expect(log).toMatch(/\[startup\] writes before first health=0\b/);

    let doctor: unknown;
    do {
      doctor = await runControlMurage(["doctor", "--url", fixture.info.url], {
        env: { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir },
      });
      if ((doctor as { ok: boolean }).ok) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    expect(doctor).toMatchObject({ ok: true, availableEngines: ["verification"] });
    console.log(JSON.stringify({ fixture: fixture.info, doctor, observed: log.split("\n").filter(line => /phase=startup\.(listen|health\.answered) |\[search-startup-test\]|writes before first health=/.test(line)) }));
  } finally { await fixture.close(); }
}, 120_000);
