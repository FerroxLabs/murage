// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { createHighLevelCredentialBridge } from "./highlevel-credentials.mjs";

const intent = { flowId: "flow-1", versionId: "version-1" };
const connection = { connectionId: "conn-1", credentialVersion: 1, grantId: "grant-1", enrollmentId: "home-1", runtimeCapability: "runtime-".repeat(8), grantCapability: "grant-".repeat(8) };

// Execute the actual main-process persistence callback, with real temporary
// bytes and an OS model that requires write access for FlushFileBuffers.
for (const platform of ["win32", "linux"]) {
  test(`G6 ${platform} durable bank flush precedes activation without truncation`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hl-bank-flush-"));
    const file = path.join(directory, "credentials.bin");
    const bytes = Buffer.from("fixture encrypted credential bytes");
    const events = [], handles = new Map();
    let failFlush = false;
    let document = {};
    try {
      const source = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
      const callback = source.split("const highlevelCredentials = createHighLevelCredentialBridge({")[1]
        ?.match(/updateDocument: (async \(derive\) => \{[\s\S]*?\n  \}),\n  request:/u)?.[1];
      assert.ok(callback, "main-process persistence callback is present");
      const updateDocument = vm.runInNewContext(`(${callback})`, {
        CREDENTIALS_FILE: file, path, process: { platform },
        updateSecureCredentialDocument: async derive => {
          document = derive(document);
          fs.writeFileSync(file, bytes);
          events.push("save");
        },
        fs: {
          openSync(name, flags) {
            const fd = fs.openSync(name, flags);
            handles.set(fd, { name, flags });
            return fd;
          },
          fsyncSync(fd) {
            const handle = handles.get(fd);
            if (platform === "win32" && handle.flags === "r") throw Error("FlushFileBuffers requires write access");
            if (failFlush) throw Error("fixture disk flush failed");
            fs.fsyncSync(fd);
            events.push(handle.name === file ? "flush-file" : "flush-directory");
          },
          closeSync(fd) { fs.closeSync(fd); handles.delete(fd); },
        },
      });
      const f = fixture({ updateDocument, readDocument: () => structuredClone(document),
        request: async route => { if (route === "prepare") return f.proposal; events.push("activate"); return { ok: true }; } });
      assert.deepEqual(await f.bridge.commit(intent), { ok: true });
      assert.deepEqual(events, platform === "win32" ? ["save", "flush-file", "activate"] : ["save", "flush-file", "flush-directory", "activate"]);
      assert.deepEqual(fs.readFileSync(file), bytes);
      assert.equal(handles.size, 0);
      events.length = 0;
      failFlush = true;
      // A fresh bridge allows the same initial proposal; a flush failure must
      // close its handle and never send the metadata commit.
      const refused = fixture({ updateDocument, request: async route => {
        if (route === "prepare") return refused.proposal;
        events.push("activate"); return { ok: true };
      } });
      document = {};
      assert.deepEqual(await refused.bridge.commit(intent), { ok: false, error: "storage" });
      assert.deepEqual(events, ["save"]);
      assert.equal(handles.size, 0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
function fixture(overrides = {}) {
  let document = {}, saved = null;
  const events = [];
  const proposal = { ...intent, commitId: "commit-1", expectedRevision: 0, initializeKey: true, connection };
  const bridge = createHighLevelCredentialBridge({
    commitCredential: "a".repeat(64), readDocument: () => structuredClone(document),
    assertSafeStorage: async () => {},
    updateDocument: async derive => { events.push("save"); document = derive(structuredClone(document)); saved = structuredClone(document); },
    request: async (route, body) => { events.push(route); if (route === "prepare") return proposal; assert.deepEqual(body.bank, saved.highlevelBank); return { ok: true }; },
    ...overrides,
  });
  return { bridge, events, document: () => document, proposal };
}
test("G6 encrypted bank precedes activation and restart retains key/version", async () => {
  const f = fixture();
  assert.deepEqual(await f.bridge.commit(intent), { ok: true });
  assert.deepEqual(f.events, ["prepare", "save", "commit"]);
  const bank = f.document().highlevelBank;
  assert.match(bank.locatorKey, /^[A-Za-z0-9_-]{43}$/u);
  const restarted = fixture({ readDocument: () => f.document() }).bridge;
  assert.deepEqual((await restarted.bootstrap()).bank, bank);
});
test("G6 bootstrap missing bank never manufactures a locator key", async () => {
  const f = fixture();
  assert.equal((await f.bridge.bootstrap()).bank, null);
  assert.deepEqual(f.events, []);
});
test("G6 unsafe storage and failed encrypted save cannot activate metadata", async () => {
  for (const overrides of [{ assertSafeStorage: async () => { throw Error("unsafe"); } }, { updateDocument: async () => { throw Error("crash"); } }]) {
    const f = fixture(overrides);
    assert.deepEqual(await f.bridge.commit(intent), { ok: false, error: "storage" });
    assert.ok(!f.events.includes("commit"));
  }
});
test("G6 lost commit response retains encrypted bank and forbids automatic resend", async () => {
  const f = fixture({ request: async route => { if (route === "prepare") return f.proposal; throw Error("lost response"); } });
  assert.deepEqual(await f.bridge.commit(intent), { ok: false, error: "outcome_unknown" });
  assert.equal(f.document().highlevelBank.revision, 1);
  assert.deepEqual(await f.bridge.commit(intent), { ok: false, error: "outcome_unknown" });
});
test("G6 renderer cannot submit secrets or arbitrary bodies", async () => {
  const f = fixture();
  for (const input of [{ ...intent, token: "fake" }, { ...intent, scopes: [] }, { ...intent, bank: {} }, { flowId: "../escape", versionId: "x" }]) {
    assert.deepEqual(await f.bridge.commit(input), { ok: false, error: "invalid_request" });
  }
  assert.deepEqual(f.events, []);
});
test("G6 strict provider-secret rejection at every bank/proposal boundary", async () => {
  for (const name of ["refreshToken", "refresh_token", "accessToken", "access_token", "clientSecret"]) {
    const f = fixture();
    f.proposal.connection[name] = "fixture-only-value";
    assert.deepEqual(await f.bridge.commit(intent), { ok: false, error: "invalid_request" });
    assert.ok(!f.events.includes("save"));
    delete f.proposal.connection[name];
  }
});
test("G6 initialize refused with existing bank; replacement/disconnect preserve key", async () => {
  const f = fixture(); await f.bridge.commit(intent);
  f.proposal.expectedRevision = 1; f.proposal.initializeKey = false; f.proposal.flowId = "flow-2"; f.proposal.versionId = "version-2"; f.proposal.connection = null;
  const old = f.document().highlevelBank.locatorKey;
  await f.bridge.commit({ flowId: "flow-2", versionId: "version-2" });
  assert.equal(f.document().highlevelBank.locatorKey, old);
});

test("G6 basic_text/unknown storage fails closed regardless of plaintext opt-in", async () => {
  const { assertHighLevelSafeStorage } = await import("./highlevel-credentials.mjs");
  for (const backend of ["basic_text", "unknown", undefined]) {
    await assert.rejects(assertHighLevelSafeStorage({ platform: "linux", storeUnavailable: false, safeStorage: { getSelectedStorageBackend: () => backend, isAsyncEncryptionAvailable: async () => true } }));
  }
  await assertHighLevelSafeStorage({ platform: "linux", storeUnavailable: false, safeStorage: { getSelectedStorageBackend: () => "gnome_libsecret", isAsyncEncryptionAvailable: async () => true } });
});
test("G6 mismatched revisions and corrupt banks cannot be replaced", async () => {
  const corrupt = fixture({ readDocument: () => ({ highlevelBank: { schema: 1 } }) });
  await assert.rejects(corrupt.bridge.bootstrap());
  assert.deepEqual(await corrupt.bridge.commit(intent), { ok: false, error: "storage" });
  const f = fixture(); f.proposal.expectedRevision = 2;
  assert.deepEqual(await f.bridge.commit(intent), { ok: false, error: "invalid_request" });
  assert.ok(!f.events.includes("save"));
});
test("G6 main/preload expose IDs only and bootstrap stays on private parent port", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  assert.match(main, /murage:highlevel-bootstrap-request/u);
  assert.match(main, /highlevelCredentials\.bootstrap\(\)/u);
  assert.doesNotMatch(preload, /highlevel.*(?:bootstrap|prepare|commitCredential|locatorKey)/u);
  assert.match(preload, /invoke\("highlevel:commit", intent\)/u);
  assert.doesNotMatch(main, /MURAGE_HIGHLEVEL_(?:BANK|COMMIT|BOOTSTRAP)/u);
});
