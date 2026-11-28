// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, it } from "vitest";
import { validatePermissionBoundary } from "./permission-boundary.mjs";

const APP = 42;
const good = () => ({
  ruleset: {
    target: "tag", enforcement: "active",
    conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
    bypass_actors: [{ actor_id: APP, actor_type: "Integration", bypass_mode: "always" }],
    rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
  },
  immutableReleases: true,
  ownerId: 7,
  principals: [{ kind: "user", id: 7, permission: "admin" }, { kind: "app", id: APP, permission: "write" }, { kind: "user", id: 8, permission: "read" }],
  orgBasePermission: "read",
  orgRulesets: [],
  deployKeys: [{ read_only: true }],
  installations: [{ app_id: APP, permissions: { contents: "write" } }, { app_id: 99, permissions: { contents: "read" } }],
});
const refusal = (mutate, code, rule) => {
  const snap = good();
  mutate(snap);
  let error;
  try { validatePermissionBoundary(snap, APP); } catch (caught) { error = caught; }
  expect(error?.code).toBe(code);
  expect(error?.rule).toBe(rule);
};

it("W11 accepts the full r10 P-a..P-d boundary", () => {
  expect(validatePermissionBoundary(good(), APP)).toBe(true);
});

it("W11 names every drifted rule", () => {
  refusal((s) => { s.ruleset.conditions.ref_name.include = ["refs/tags/v*"]; }, "PERMISSION_DRIFT", "ruleset-include");
  refusal((s) => { s.ruleset.rules = [{ type: "creation" }, { type: "deletion" }]; }, "PERMISSION_DRIFT", "ruleset-update");
  refusal((s) => { s.immutableReleases = false; }, "PERMISSION_DRIFT", "immutable");
  refusal((s) => { s.principals.push({ kind: "user", id: 9, permission: "write" }); }, "PERMISSION_DRIFT", "collaborators");
  refusal((s) => { s.ruleset.bypass_actors.push({ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }); }, "PERMISSION_DRIFT", "bypass");
  refusal((s) => { s.deployKeys = [{ read_only: false }]; }, "PERMISSION_DRIFT", "deploy-key");
  refusal((s) => { s.installations.push({ app_id: 100, permissions: { contents: "write" } }); }, "PERMISSION_DRIFT", "installations");
  refusal((s) => { s.orgBasePermission = "write"; }, "PERMISSION_DRIFT", "org-base");
  refusal((s) => { s.orgRulesets = [{ target: "tag", enforcement: "active", conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/tags/v1*"] } }, bypass_actors: [] }]; }, "PERMISSION_DRIFT", "org-ruleset");
});

it("W11 a field the API did not return is PERMISSION_UNVERIFIED, never absent-means-fine", () => {
  refusal((s) => { delete s.immutableReleases; }, "PERMISSION_UNVERIFIED", "immutable");
  refusal((s) => { delete s.orgBasePermission; }, "PERMISSION_UNVERIFIED", "org-base");
  refusal((s) => { delete s.orgRulesets; }, "PERMISSION_UNVERIFIED", "org-rulesets");
  refusal((s) => { delete s.principals; }, "PERMISSION_UNVERIFIED", "principals");
  refusal((s) => { delete s.ruleset.bypass_actors; }, "PERMISSION_UNVERIFIED", "bypass");
  expect(() => validatePermissionBoundary(undefined, APP)).toThrow("PERMISSION_UNVERIFIED");
});

it("W11b incomplete installation evidence is PERMISSION_UNVERIFIED, never authorizes (r2 ASTRA+OPUS High)", () => {
  refusal((s) => { s.installations.push({ app_id: 100, permissions: {} }); }, "PERMISSION_UNVERIFIED", "installations");
  refusal((s) => { s.installations.push({ app_id: 100, permissions: { contents: "WRITE" } }); }, "PERMISSION_UNVERIFIED", "installations");
  refusal((s) => { s.installations.push({ app_id: 100, permissions: { contents: 5 } }); }, "PERMISSION_UNVERIFIED", "installations");
  refusal((s) => { s.installations.push({ permissions: { contents: "read" } }); }, "PERMISSION_UNVERIFIED", "installations");
  refusal((s) => { s.installations.push({ app_id: APP, permissions: {} }); }, "PERMISSION_UNVERIFIED", "installations");
  refusal((s) => { s.installations.push(null); }, "PERMISSION_UNVERIFIED", "installations");
  refusal((s) => { delete s.installations; }, "PERMISSION_UNVERIFIED", "installations");
});

it("W11 a ruleset include of only `refs/tags/v*` (the old validator's rule) is drift", () => {
  const snap = good();
  snap.ruleset.conditions.ref_name.include = ["refs/tags/v*"];
  expect(() => validatePermissionBoundary(snap, APP)).toThrow("PERMISSION_DRIFT:ruleset-include");
});
