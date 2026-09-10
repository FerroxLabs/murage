import test from "node:test";
import assert from "node:assert/strict";
import { fluxCredentialStatus, planFluxCredentialChange, resolveFluxAlias } from "./flux-credential-policy.mjs";
const row = (id, key = "sk-flux-FAKE_ONLY", enabled = true) => ({ id, key, enabled, preset: "flux", label: id, revision: `rev-${id}` });
const state = (rows = [], workspaceKey = "", aliases = []) => ({ bank: JSON.stringify(rows), workspaceKey, aliases });
const change = (saved, input) => planFluxCredentialChange(saved, { revision: fluxCredentialStatus(saved).revision, ...input });
test("equal keys consolidate into one credential while retaining disabled aliases and other accounts", () => {
  const other = { ...row("other"), preset: "mistral", key: "FAKE_OTHER_KEY" };
  const saved = state([row("first"), row("disabled", undefined, false), other], "sk-flux-FAKE_ONLY");
  const result = change(saved, { action: "consolidate" });
  assert.deepEqual(JSON.parse(result.bank), [other]);
  assert.equal(result.workspaceKey, "sk-flux-FAKE_ONLY");
  assert.deepEqual(result.aliases.map(({ id, enabled }) => ({ id, enabled })), [{ id: "first", enabled: true }, { id: "disabled", enabled: false }]);
  assert.equal(JSON.stringify(result.aliases).includes("FAKE"), false);
});
test("different keys require explicit choice and public status never returns keys", () => {
  const saved = state([row("named", "sk-flux-FAKE_SECOND")], "sk-flux-FAKE_FIRST");
  const status = fluxCredentialStatus(saved);
  assert.equal(status.conflict, true);
  assert.equal(JSON.stringify(status).includes("FAKE"), false);
  for (const action of ["consolidate", "replace"]) assert.throws(() => change(saved, { action, ...(action === "replace" ? { key: "sk-flux-FAKE_THIRD" } : {}) }), /Choose which/);
  assert.equal(change(saved, { action: "select", connectionId: "named" }).workspaceKey, "sk-flux-FAKE_SECOND");
  assert.equal(change(saved, { action: "select", connectionId: "legacy-flux" }).workspaceKey, "sk-flux-FAKE_FIRST");
  assert.throws(() => change(saved, { action: "select", connectionId: "unknown" }), /Choose an existing/);
});
test("stale revision fences changed keys even if provider revisions did not change", () => {
  const original = state([row("named")]);
  const revision = fluxCredentialStatus(original).revision;
  assert.throws(() => planFluxCredentialChange(state([row("named", "sk-flux-FAKE_CHANGED")]), { action: "select", connectionId: "named", revision }), /changed/);
});
test("disconnect removes every stored Flux key and leaves aliases unavailable", () => {
  const result = change(state([row("named", "sk-flux-FAKE_SECOND")], "sk-flux-FAKE_FIRST"), { action: "disconnect" });
  assert.equal(result.workspaceKey, "");
  assert.equal(result.bank, "[]");
  assert.equal(resolveFluxAlias(result.aliases[0], result.workspaceKey, "revision"), null);
});
test("alias resolves new credential under old ID, preserves disabled state and changes revision", () => {
  const alias = change(state([row("named", undefined, false)], "sk-flux-FAKE_ONLY"), { action: "consolidate" }).aliases[0];
  const first = resolveFluxAlias(alias, "sk-flux-FAKE_ONLY", "first");
  const next = resolveFluxAlias(alias, "sk-flux-FAKE_NEXT", "next");
  assert.equal(next.id, "named"); assert.equal(next.enabled, false);
  assert.equal(next.key, "sk-flux-FAKE_NEXT"); assert.notEqual(first.revision, next.revision);
});
test("disabled-only credentials require explicit selection before becoming canonical", () => {
  const saved = state([row("disabled", undefined, false)]);
  assert.throws(() => change(saved, { action: "consolidate" }), /Select a saved/);
  assert.equal(change(saved, { action: "select", connectionId: "disabled" }).workspaceKey, "sk-flux-FAKE_ONLY");
});
test("aliases reject collisions, secrets and injection; mutation never accepts aliases", () => {
  const alias = { id: "same", label: "Same", enabled: true, revision: "rev" };
  assert.throws(() => fluxCredentialStatus(state([row("same")], "", [alias])), /invalid/);
  assert.throws(() => fluxCredentialStatus(state([], "", [{ ...alias, key: "FAKE_SECRET" }])), /invalid/);
  assert.throws(() => change(state(), { action: "connect", key: "sk-flux-FAKE_ONLY", aliases: [alias] }), /Invalid/);
});
test("connect and replacement enforce provider binding and preserve existing aliases", () => {
  const connected = change(state(), { action: "connect", key: "sk-flux-FAKE_ONLY" });
  assert.throws(() => change(connected, { action: "connect", key: "sk-flux-FAKE_OTHER" }), /already/);
  assert.throws(() => change(connected, { action: "replace", key: "sk-ant-FAKE_ONLY" }), /different provider/);
  assert.equal(change(connected, { action: "replace", key: "sk-flux-FAKE_OTHER" }).workspaceKey, "sk-flux-FAKE_OTHER");
});
test("different raw configuration and inherited environment keys require explicit selection", () => {
  const saved = { ...state([], "sk-flux-FAKE_MANAGED"), fileWorkspaceKey: "sk-flux-FAKE_FILE", ambientWorkspaceKey: "sk-flux-FAKE_ENV" };
  const status = fluxCredentialStatus(saved);
  assert.equal(status.conflict, true); assert.equal(status.choices.length, 3);
  assert.equal(JSON.stringify(status).includes("FAKE"), false);
  assert.throws(() => change(saved, { action: "replace", key: "sk-flux-FAKE_NEXT" }), /Choose which/);
  assert.equal(change(saved, { action: "select", connectionId: "legacy-flux-file" }).workspaceKey, "sk-flux-FAKE_FILE");
  assert.equal(change(saved, { action: "select", connectionId: "legacy-flux-environment" }).workspaceKey, "sk-flux-FAKE_ENV");
});
