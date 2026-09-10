import assert from "node:assert/strict";
import test from "node:test";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { mutateFluxCredentials } from "./flux-connection-control.mjs";
import { fluxCredentialStatus, planFluxCredentialChange } from "./flux-credential-policy.mjs";
import { workspaceCredentialEnv } from "./workspace-credentials.mjs";
function fixture({ busy = false, lostAck = false, rollbackFails = false } = {}) {
  let disk = { unrelated: "PRESERVE", fluxApiKey: "sk-flux-FAKE_OLD" }, runtime = { bank: "[]", workspaceKey: disk.fluxApiKey, aliases: [] }, previous, next, fenced = false, writes = 0;
  const secure = createSecureCredentialState(disk, async value => { assert.equal(fenced, true); writes++; disk = structuredClone(value); });
  const options = { packaged: true, updateDocument: (...args) => secure.update(...args), post: async (_route, body) => {
    if (body.phase === "begin") { if (busy) throw Error("Finish running work"); previous = structuredClone(runtime); next = planFluxCredentialChange(runtime, body.input); fenced = true; return { lease: "fixture-lease", next }; }
    assert.equal(body.lease, "fixture-lease");
    if (body.phase === "commit") { runtime = next; if (lostAck) throw Error("lost acknowledgement"); return fluxCredentialStatus(runtime); }
    if (body.phase === "rollback") { if (rollbackFails) throw Error("unknown runtime"); runtime = previous; return { restored: true }; }
    if (body.phase === "finish") { fenced = false; return { finished: true }; }
    assert.fail("unexpected phase");
  } };
  return { options, input: { action: "replace", revision: fluxCredentialStatus(runtime).revision, key: "sk-flux-FAKE_NEXT" }, disk: () => disk, runtime: () => runtime, fenced: () => fenced, writes: () => writes };
}
test("Flux encrypted document update holds idle reservation through both credential slots and aliases", async () => {
  const f = fixture(); const result = await mutateFluxCredentials(f.input, f.options);
  assert.equal(f.disk().fluxApiKey, "sk-flux-FAKE_NEXT"); assert.equal(f.disk().modelProviderConnections, "[]"); assert.equal(f.disk().fluxConnectionAliases, "[]"); assert.equal(f.disk().unrelated, "PRESERVE"); assert.equal(f.fenced(), false);
  assert.equal(JSON.stringify(result).includes("FAKE"), false);
});
test("active work refuses before any encrypted credential write", async () => {
  const f = fixture({ busy: true }); await assert.rejects(mutateFluxCredentials(f.input, f.options), /running work/); assert.equal(f.writes(), 0);
});
test("lost acknowledgement restores runtime and encrypted document before releasing reservation", async () => {
  const f = fixture({ lostAck: true }), before = structuredClone(f.disk());
  await assert.rejects(mutateFluxCredentials(f.input, f.options), /lost acknowledgement/);
  assert.deepEqual(f.disk(), before); assert.equal(f.runtime().workspaceKey, before.fluxApiKey); assert.equal(f.fenced(), false);
});
test("unknown compensation keeps runtime admission fenced", async () => {
  const f = fixture({ lostAck: true, rollbackFails: true });
  await assert.rejects(mutateFluxCredentials(f.input, f.options), /could not be reconciled/); assert.equal(f.fenced(), true);
});
test("managed disconnect overrides inherited environment on restart without retaining old key", () => {
  assert.deepEqual(workspaceCredentialEnv({ fluxApiKey: "", fluxConnectionManaged: "true", fluxConnectionAliases: "[]" }), { FLUX_API_KEY: "", MURAGE_FLUX_CONNECTION_ALIASES: "[]" });
});
