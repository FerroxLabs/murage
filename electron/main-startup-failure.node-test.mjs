// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance (ACCEPTANCE.md row B3): a child that exits before it listens (a start that could not open its database) ends in the launcher's failure
// state after finite retries. No further spawn follows, and the serving-child supervisor (superviseServerChild) is never consulted for a child that
// never served. Runs the real startServerPackaged text from main.mjs (the pattern of startup-slow.test.mjs); only the child itself is a stub.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");
const start = text.indexOf("async function startServerPackaged()");
const source = text.slice(start, text.indexOf("function syncManagedComposioCredentials()", start));
const GUARD = 50; // a runaway loop fails here, by assertion, instead of hanging the run

function run(reasonFor, { onSpawn = () => {} } = {}) {
  const spawned = [], supervised = [], pauses = [];
  const scope = {
    assertDesktopStartupActive: () => {},
    startServerOn: async (port) => {
      spawned.push(port);
      assert.ok(spawned.length <= GUARD, `the launcher is still spawning after ${GUARD} children`);
      onSpawn(spawned.length);
      return { proc: null, reason: reasonFor(spawned.length) };
    },
    superviseServerChild: (...args) => { supervised.push(args); },
    attentionWiring: null, attentionMain: null, attentionSurfaces: null,
    mcpServers: { resume: async () => {} }, slog: () => {},
    setTimeout: (done, ms) => { pauses.push(ms); done(); return 0; },
  };
  const body = `let memoryUpgradeBlocked=null, serverStartSlow=false, serverStartConflictOnly=false, serverProc=null, SERVER_PORT=0;
    ${source}
    return startServerPackaged().then((ready) => ({ ready, serverStartSlow, serverStartConflictOnly, serverProc, SERVER_PORT }));`;
  return new Function(...Object.keys(scope), body)(...Object.values(scope)).then((result) => ({ ...result, spawned, supervised, pauses }));
}

test("a child that exits before listening: finite retries, then the failure state", async () => {
  const result = await run(() => "exited");
  assert.equal(result.ready, false);
  assert.deepEqual(result.spawned, [8799, 18799, 28799, 8799, 18799, 28799], "three ports, two passes, nothing more");
  assert.equal(result.pauses.length, 2, "one pause after each pass");
  assert.equal(result.serverProc, null);
  assert.equal(result.SERVER_PORT, 0);
  assert.deepEqual(result.supervised, [], "the serving-child supervisor is not consulted for a child that never served");
  assert.equal(result.serverStartSlow, false);
  assert.equal(result.serverStartConflictOnly, false, "an exited child is not a port conflict");
});

test("no spawn follows the failure state", async () => {
  const result = await run(() => "exited");
  const settled = result.spawned.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(result.spawned.length, settled);
});

test("a child that does serve on a later try is supervised exactly once", async () => {
  const spawned = [], supervised = [];
  const scope = {
    assertDesktopStartupActive: () => {},
    startServerOn: async (port) => { spawned.push(port); return spawned.length === 4 ? { proc: { pid: 1 }, lifecycle: {} } : { proc: null, reason: "exited" }; },
    superviseServerChild: (...args) => { supervised.push(args); },
    attentionWiring: null, attentionMain: null, attentionSurfaces: null,
    mcpServers: { resume: async () => {} }, slog: () => {},
    setTimeout: (done) => { done(); return 0; },
  };
  const body = `let memoryUpgradeBlocked=null, serverStartSlow=false, serverStartConflictOnly=false, serverProc=null, SERVER_PORT=0;
    ${source}
    return startServerPackaged().then((ready) => ({ ready, SERVER_PORT }));`;
  const result = await new Function(...Object.keys(scope), body)(...Object.values(scope));
  assert.deepEqual(result, { ready: true, SERVER_PORT: 8799 });
  assert.equal(supervised.length, 1);
  assert.equal(spawned.length, 4);
});
