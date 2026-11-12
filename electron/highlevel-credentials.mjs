// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/u.test(value);
const capability = value => typeof value === "string" && value.length >= 32 && value.length <= 4096 && /^[\x21-\x7e]+$/u.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const grantKeys = ["connectionId", "credentialVersion", "grantId", "enrollmentId", "runtimeCapability", "grantCapability"];
const grant = value => value === null || (exact(value, grantKeys) && ["connectionId", "grantId", "enrollmentId"].every(key => id(value[key])) && positive(value.credentialVersion) && capability(value.runtimeCapability) && capability(value.grantCapability));
export function validHighLevelBank(bank) {
  return exact(bank, ["schema", "revision", "locatorKey", "connection"]) && bank.schema === 1 && positive(bank.revision)
    && typeof bank.locatorKey === "string" && /^[A-Za-z0-9_-]{43}$/u.test(bank.locatorKey) && grant(bank.connection);
}
export function validHighLevelIntent(input) {
  return exact(input, ["flowId", "versionId"]) && id(input.flowId) && id(input.versionId);
}
const fail = error => ({ ok: false, error });

/** Main-only adapter. updateDocument MUST resolve after encrypted durable save.
 * No afterPersist callback: an uncertain activation must never roll the bank back.
 * request is a private, fixed-route transport with the launch commit credential.
 * assertSafeStorage must reject basic_text/unknown even with plaintext opt-in. */
export function createHighLevelCredentialBridge({ commitCredential, readDocument, updateDocument, assertSafeStorage, request }) {
  if (typeof commitCredential !== "string" || !/^[a-f0-9]{64}$/u.test(commitCredential)) throw Error("invalid launch credential");
  let tail = Promise.resolve(), uncertain = false;
  const readBank = () => {
    const document = readDocument();
    if (!record(document)) throw Error("unreadable credential document");
    if (!Object.hasOwn(document, "highlevelBank")) return null;
    if (!validHighLevelBank(document.highlevelBank)) throw Error("invalid HighLevel bank");
    return structuredClone(document.highlevelBank);
  };
  return {
    async bootstrap() {
      await tail;
      await assertSafeStorage();
      return { schema: 1, commitCredential, bank: readBank() };
    },
    commit(input) {
      // No secret-bearing renderer input reaches either storage or the server.
      if (!validHighLevelIntent(input)) return Promise.resolve(fail("invalid_request"));
      const intent = structuredClone(input);
      const run = async () => {
        if (uncertain) return fail("outcome_unknown");
        let previous;
        try { await assertSafeStorage(); previous = readBank(); } catch { return fail("storage"); }
        let proposal;
        try { proposal = await request("prepare", intent, commitCredential); } catch { return fail("invalid_request"); }
        if (!exact(proposal, ["flowId", "versionId", "commitId", "expectedRevision", "initializeKey", "connection"])
          || proposal.flowId !== intent.flowId || proposal.versionId !== intent.versionId || !id(proposal.commitId)
          || proposal.expectedRevision !== (previous?.revision ?? 0) || proposal.initializeKey !== (previous === null)
          || !grant(proposal.connection)) return fail("invalid_request");
        const bank = { schema: 1, revision: proposal.expectedRevision + 1,
          locatorKey: previous?.locatorKey ?? randomBytes(32).toString("base64url"), connection: structuredClone(proposal.connection) };
        if (!validHighLevelBank(bank)) return fail("invalid_request");
        try {
          await assertSafeStorage();
          await updateDocument(document => {
            const current = document.highlevelBank ?? null;
            if (JSON.stringify(current) !== JSON.stringify(previous)) throw Error("stale HighLevel bank");
            return { ...document, highlevelBank: bank };
          });
        } catch { return fail("storage"); }
        // A lost response may already have activated the exact metadata. Retain
        // the saved bank and stop all further mutations until restart/reconciliation.
        uncertain = true;
        try {
          const result = await request("commit", { commitId: proposal.commitId, bank }, commitCredential);
          if (!exact(result, ["ok"]) || result.ok !== true) return fail("outcome_unknown");
          uncertain = false;
          return { ok: true };
        } catch { return fail("outcome_unknown"); }
      };
      const result = tail.then(run, run);
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
}

/** HighLevel never permits the general plaintext-secret opt-in. */
export async function assertHighLevelSafeStorage({ safeStorage, storeUnavailable, platform = process.platform }) {
  if (storeUnavailable) throw Error("HighLevel secure storage unavailable");
  if (platform === "linux") {
    const backend = safeStorage.getSelectedStorageBackend?.();
    if (!backend || backend === "basic_text" || backend === "unknown") throw Error("HighLevel secure storage unavailable");
  }
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw Error("HighLevel secure storage unavailable");
}
