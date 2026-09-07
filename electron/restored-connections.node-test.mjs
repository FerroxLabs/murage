import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { restoredConnectionProfile, restoredHarnessEnvironment, restoredBrowserPartition, RESTORED_CONNECTIONS_FILE } from "./restored-connections.mjs";

test("fresh connection paths cannot reuse the original credential or device directories", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "murage-connection-profile-"));
  try {
    const data = path.join(root, "installation"); mkdirSync(data);
    const old = path.join(root, "old-credentials.bin"); writeFileSync(old, "private-old-canary");
    assert.equal(restoredConnectionProfile(data), null);
    const id = randomUUID();
    writeFileSync(path.join(data, RESTORED_CONNECTIONS_FILE), JSON.stringify({ version: 1, id }));
    const profile = restoredConnectionProfile(data);
    assert.equal(profile.credentialsFile, path.join(data, "connection-profiles", id, "credentials.bin"));
    assert.equal(profile.companionState, path.join(data, "connection-profiles", id, "companion"));
    assert.equal(existsSync(profile.directory), false, "reading policy must not create connection state");
    assert.equal(readFileSync(old, "utf8"), "private-old-canary");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("damaged or redirected marker fails closed rather than falling back to old connections", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "murage-connection-marker-"));
  const file = path.join(root, RESTORED_CONNECTIONS_FILE);
  try {
    for (const value of ["not-json", "null", JSON.stringify({ version: 1, id: "../../old" }), JSON.stringify({ version: 1, id: {} })]) {
      writeFileSync(file, value);
      assert.throws(() => restoredConnectionProfile(root), error => error.code === "RESTORE_REVIEW_REQUIRED");
    }
    if (process.platform !== "win32") {
      rmSync(file);
      symlinkSync(path.join(root, "missing"), file);
      assert.throws(() => restoredConnectionProfile(root), error => error.code === "RESTORE_REVIEW_REQUIRED");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("connection filtering preserves native provider and Fuigo inheritance", () => {
  const env = { COMPOSIO_API_KEY: "old-project", MURAGE_COMPOSIO_BROKER_TOKEN: "old-broker", MURAGE_COMPANION_DIR: "/old/devices", ANTHROPIC_API_KEY: "native-provider", HOME: "/native-home", FUIGO_CONFIG: "/native-config" };
  const next = restoredHarnessEnvironment(env, { id: randomUUID() });
  assert.equal(next.COMPOSIO_API_KEY, undefined);
  assert.equal(next.MURAGE_COMPANION_DIR, undefined);
  assert.equal(next.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY);
  assert.equal(next.HOME, env.HOME);
  assert.equal(next.FUIGO_CONFIG, env.FUIGO_CONFIG);
  assert.deepEqual(restoredHarnessEnvironment(env, null), env);
  assert.equal(env.COMPOSIO_API_KEY, "old-project");
});
test("both bot and named browser partitions move to a fresh cookie scope", () => {
  const first = { id: randomUUID() }, second = { id: randomUUID() };
  for (const original of ["persist:murage-browser-bot", "persist:murage-browser-profile-work"]) {
    assert.notEqual(restoredBrowserPartition(original, first), original);
    assert.notEqual(restoredBrowserPartition(original, first), restoredBrowserPartition(original, second));
    assert.equal(restoredBrowserPartition(original, null), original);
  }
  assert.equal(restoredBrowserPartition("murage-browser-guest", first), "murage-browser-guest");
});
