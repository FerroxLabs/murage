// 1.0.23 queuedsend (MAIN-RULING updater diag): when "Restart to update" is refused before anything stops (the work-in-progress
// probe of /api/bots timed out, or the pre-upgrade backup check refused), the reason code and message are written to updater.log
// through the updater's own logger, and the card keeps its plain message.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { prepareBackedUpInstall } from "./preupgrade-continuation.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { prepareUpdaterRestart } from "./updater-restart.mjs";

function harness(beforeInstall) {
  const updater = new EventEmitter();
  updater.on("error", () => {});
  const lines = [];
  updater.logger = { warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)), info: () => {}, debug: () => {} };
  updater.downloadUpdate = () => { updater.emit("update-downloaded", { version: "2.0.0" }); return Promise.resolve(["/tmp/Murage-2.0.0-amd64.deb"]); };
  let installs = 0;
  updater.quitAndInstall = () => installs++;
  let state = { status: "idle" };
  const coordinator = createUpdaterCoordinator(updater, (patch) => { state = { ...state, ...patch }; }, { beforeInstall });
  return { coordinator, lines, state: () => state, installs: () => installs };
}

test("the work-in-progress probe timing out is logged with its reason code, the card stays plain", async (t) => {
  // a real /api/bots that never answers, probed with the same bounded fetch the desktop uses
  const server = createServer(() => { /* never answers */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const h = harness(() => prepareUpdaterRestart({
    environment: {}, isClosing: () => false, isCleanedUp: () => false, cleanup: async () => {},
    readActivity: async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/bots?messages=0`, { signal: AbortSignal.timeout(150), redirect: "error" });
      return response.json();
    },
  }));
  await h.coordinator.download();
  await h.coordinator.install();
  assert.equal(h.installs(), 0);
  assert.equal(h.state().status, "error");
  assert.equal(h.state().message, "Could not check current work. Try again before restarting to update.");
  const line = h.lines.find((entry) => entry.includes("restart to update refused before it started"));
  assert.ok(line, `no refusal line in updater.log: ${JSON.stringify(h.lines)}`);
  assert.match(line, /code=UPDATER_ACTIVITY_TIMEOUT/);
  assert.match(line, /message=Could not check current work/);
  assert.doesNotMatch(String(h.state().message), /code=|UPDATER_|cause=/);
});

test("the pre-upgrade backup check refusing is logged with its reason, the card stays plain", async () => {
  // shaped as the production backup host refuses (electron/backup-schedule-host.mjs): an Error whose message is the code, no .code
  const h = harness((candidate) => prepareBackedUpInstall(candidate, {
    backup: { requestUpgrade: async () => { throw new Error("BACKUP_REVIEW_REQUIRED"); } },
    prepareNormal: async () => assert.fail("a refused backup check never reaches the restart"),
  }));
  await h.coordinator.download();
  await h.coordinator.install();
  assert.equal(h.installs(), 0);
  assert.equal(h.state().status, "error");
  assert.doesNotMatch(String(h.state().message), /BACKUP_|code=|cause=/);
  assert.match(String(h.state().message), /check before restarting did not pass/);
  const line = h.lines.find((entry) => entry.includes("restart to update refused before it started"));
  assert.ok(line, `no refusal line in updater.log: ${JSON.stringify(h.lines)}`);
  assert.match(line, /code=BACKUP_REVIEW_REQUIRED message=BACKUP_REVIEW_REQUIRED/);
});
