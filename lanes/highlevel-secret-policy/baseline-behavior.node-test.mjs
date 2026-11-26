// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behavioral witnesses for the pre-C1 implementation. See afix-verification.md
// for the exact git-show snapshot commands. No missing-module fallback/stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const baseline = process.env.HL_WITNESS_MODE === "baseline";
const root = new URL(baseline ? "./afix-evidence/baseline/" : "../../", import.meta.url);
const { createSecureCredentialState } = await import(new URL("electron/secure-credential-state.mjs", root));
const storage = baseline
  ? await import(new URL("electron/secret-storage-policy.mjs", root))
  : await import(new URL("electron/highlevel-credentials.mjs", root));

test("G6 baseline witness: HighLevel refuses basic_text even with the general plaintext opt-in", async () => {
  const options = { platform: "linux", storeUnavailable: false,
    env: { MURAGE_ALLOW_PLAINTEXT_SECRETS: "1" },
    safeStorage: { getSelectedStorageBackend: () => "basic_text", isAsyncEncryptionAvailable: async () => true } };
  let refused;
  if (baseline) refused = (await storage.secretWriteRefusal(options)) !== null;
  else {
    try { await storage.assertHighLevelSafeStorage(options); refused = false; }
    catch { refused = true; }
  }
  assert.equal(refused, true, "HighLevel capability storage must reject basic_text despite the generic opt-in");
});

test("G6 baseline witness: lost activation acknowledgement retains the persisted credential", async () => {
  let disk = {};
  const state = createSecureCredentialState({}, async next => { disk = structuredClone(next); });
  const connection = { connectionId: "conn-1", credentialVersion: 1, grantId: "grant-1", enrollmentId: "home-1",
    runtimeCapability: "runtime-".repeat(8), grantCapability: "grant-".repeat(8) };
  const intent = { flowId: "flow-1", versionId: "version-1" };
  const lost = async () => { throw Error("fixture: activation applied, acknowledgement lost"); };
  let retained;
  if (baseline) {
    const source = readFileSync(new URL("electron/main.mjs", root), "utf8");
    const start = source.indexOf('ipcMain.handle("credential:set", ');
    const end = source.indexOf("\n});", start);
    assert.ok(start >= 0 && end > start, "baseline credential handler must be present");
    const handler = source.slice(start + 'ipcMain.handle("credential:set", '.length, end + 2);
    // Execute the original packaged HighLevel PIT save handler. The fake
    // harness accepts activation but loses its acknowledgement.
    const save = vm.runInNewContext(`(${handler})`, {
      CREDENTIAL_PATCH: { highlevelPrivateToken: value => ({ highlevel: { privateToken: value } }) },
      app: { isPackaged: true }, assertSecretStorageWritable: async () => {},
      ensureDesktopSurfaceSecret: async () => true, SERVER_PORT: 1, desktopSurfaceSecret: "fixture",
      fetch: lost, updateSecureCredentialDocument: state.update,
    });
    await assert.rejects(save({}, "highlevelPrivateToken", connection.grantCapability));
    retained = disk.highlevelPrivateToken;
  } else {
    const bridge = storage.createHighLevelCredentialBridge({ commitCredential: "a".repeat(64),
      readDocument: state.read, updateDocument: derive => state.update(derive), assertSafeStorage: async () => {},
      request: async route => route === "prepare"
        ? { ...intent, commitId: "commit-1", expectedRevision: 0, initializeKey: true, connection }
        : lost(),
    });
    assert.deepEqual(await bridge.commit(intent), { ok: false, error: "outcome_unknown" });
    retained = disk.highlevelBank?.connection?.grantCapability;
    assert.equal(state.read().highlevelBank?.revision, 1);
  }
  assert.equal(retained, connection.grantCapability, "an uncertain activation must retain the saved credential");
});

test("G2 baseline witness: endpoint permission alone cannot authorize ID custom-field preparation", async () => {
  const args = { contactId: "c1", customFields: [{ id: "field1", value: "fixture" }] };
  const metadata = { connectionId: "conn1", locationId: "loc1", connectionEpoch: 1, credentialVersion: 1,
    scopes: ["contacts.readonly", "contacts.write"] };
  let result;
  if (baseline) {
    const source = readFileSync(new URL("server/highlevel/host.ts", root), "utf8");
    const start = source.indexOf("  async #authorizeOperation(");
    const end = source.indexOf("  async #operationCall(", start);
    assert.ok(start >= 0 && end > start, "baseline authorization method must be present");
    // Run the complete, unchanged original method inside a class with fake
    // surrounding grant/connection checks. Only TypeScript types are stripped.
    const wrapper = `class Witness {
      #deps; constructor(deps) { this.#deps = deps; }
      #operationGrant() { return { accountId: "conn1" }; }
      #claimRefusal() { return false; }
      ${source.slice(start, end)}
      run(claim, spec, args) { return this.#authorizeOperation(claim, spec, args, "C"); }
    }; Witness`;
    const Witness = vm.runInNewContext(stripTypeScriptTypes(wrapper), {
      botAccessPolicy: () => ({ revision: 1 }), accessRoleBinding: () => "fixture-role",
    });
    const witness = new Witness({ bot: () => ({ highlevelAccess: { revision: 1 } }),
      leases: { connection: async () => ({ ...metadata, state: "connected" }) }, operationScopes: () => metadata.scopes });
    result = await witness.run({ botId: "fixture-bot" }, { endpoint: { scope: "contacts.write" } }, args);
  } else {
    const { planInvocation } = await import(new URL("server/highlevel/scope-policy.ts", root));
    result = planInvocation("contacts.update", args, metadata);
  }
  assert.equal(result.ok, false, "missing locations/customFields.readonly must refuse before ownership or preparation");
  if (!baseline) assert.deepEqual(result.refusal.permissionIds, ["locations/customFields.readonly"]);
});
