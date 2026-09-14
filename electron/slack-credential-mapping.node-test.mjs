import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";
import { migrateWorkspaceCredentials, workspaceCredentialEnv, WORKSPACE_CREDENTIALS } from "./workspace-credentials.mjs";
const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
test("Slack credentials use canonical encrypted rows and preserve chosen identity", () => {
  const match = source.match(/const CREDENTIAL_PATCH = (\{[\s\S]*?\n\});/); assert.ok(match);
  const handlers = runInNewContext(`(${match[1]})`);
  for (const [name, field, env] of [["slackAppToken", "appToken", "MURAGE_SLACK_APP_TOKEN"], ["slackBotToken", "botToken", "MURAGE_SLACK_BOT_TOKEN"]]) {
    assert.deepEqual(JSON.parse(JSON.stringify(handlers[name]("fake-secret"))), { slack: { [field]: "fake-secret" } });
    assert.deepEqual(WORKSPACE_CREDENTIALS.find(row => row.name === name), { section: "slack", field, name, env });
  }
  const migrated = migrateWorkspaceCredentials({ slack: { appToken: "fake-a", botToken: "fake-b", teamId: "TEAM" } }, { otherKey: "keep" });
  assert.deepEqual(migrated.config, { slack: { teamId: "TEAM" } });
  assert.deepEqual(workspaceCredentialEnv(migrated.credentials), { MURAGE_SLACK_APP_TOKEN: "fake-a", MURAGE_SLACK_BOT_TOKEN: "fake-b" });
  assert.equal(migrated.credentials.otherKey, "keep");
});
test("actual Slack credential IPC uses encrypted commit even in dev, and refuses unavailable encryption", async () => {
  const handler = source.slice(source.indexOf('ipcMain.handle("credential:set"'), source.indexOf("async function broadcastDesktopCapabilities"));
  for (const encrypted of [true, false]) {
    let invoke, persisted = 0, posted = 0;
    new Function("ipcMain", "safeStorage", "updateSecureCredentialDocument", "fetch", `
      const app={isPackaged:false},desktopSurfaceSecret="fixture-proof",SERVER_PORT=1;
      const CREDENTIAL_PATCH={slackAppToken:value=>({slack:{appToken:value}})};
      ${handler}
    `)({ handle: (_name, fn) => { invoke = fn; } }, { isAsyncEncryptionAvailable: async () => encrypted },
      async (derive, apply) => { assert.equal(derive({}).slackAppToken, "fake-secret"); persisted++; return apply(); },
      async (url, init) => { assert.match(url, /secretStorage=external$/); assert.equal(init.headers["x-murage-surface-secret"], "fixture-proof"); posted++; return { ok: true, json: async () => ({ saved: true }) }; });
    if (encrypted) { await invoke({}, "slackAppToken", "fake-secret"); assert.equal(persisted, 1); assert.equal(posted, 1); }
    else { await assert.rejects(invoke({}, "slackAppToken", "fake-secret"), /credential store is unavailable/); assert.equal(persisted, 0); assert.equal(posted, 0); }
  }
});
