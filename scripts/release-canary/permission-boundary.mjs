// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Live S4 validator (O23 section 3, r10 P-a..P-d). Replaces tag-ruleset.mjs, which accepted a `refs/tags/v*`
// creation+deletion ruleset. A value that breaks a rule is PERMISSION_DRIFT; a field the API did not return
// is PERMISSION_UNVERIFIED (absent never means fine). Both refuse and withhold the watchdog heartbeat.
export class PermissionError extends Error {
  constructor(code, rule) {
    super(`${code}:${rule}`);
    this.code = code;
    this.rule = rule;
  }
}
const drift = (rule) => { throw new PermissionError("PERMISSION_DRIFT", rule); };
const unverified = (rule) => { throw new PermissionError("PERMISSION_UNVERIFIED", rule); };
const WRITE = new Set(["write", "maintain", "admin"]);
const READ = new Set(["none", "read", "triage"]);

function need(value, rule, ok) {
  if (value === undefined || value === null || !ok(value)) unverified(rule);
  return value;
}
const isArray = (value) => Array.isArray(value);

function checkRepoRuleset(ruleset, appId) {
  const { target, enforcement, conditions, bypass_actors: actors, rules } = need(ruleset, "ruleset", (v) => typeof v === "object");
  const refs = need(conditions?.ref_name, "ruleset-conditions", (v) => isArray(v.include) && isArray(v.exclude));
  need(actors, "bypass", isArray);
  need(rules, "ruleset-rules", isArray);
  if (target !== "tag" || enforcement !== "active") drift("ruleset-target");
  // ALL tags, not a `v*` pattern: a non-v tag must not be creatable by a principal with write.
  if (!refs.include.includes("~ALL") || refs.exclude.length || Object.keys(conditions).length !== 1) drift("ruleset-include");
  for (const type of ["creation", "update", "deletion"]) {
    if (!rules.some((rule) => rule?.type === type)) drift(`ruleset-${type}`);
  }
  if (actors.length !== 1 || actors[0]?.actor_type !== "Integration" || actors[0].actor_id !== appId ||
      actors[0].bypass_mode !== "always") drift("bypass");
}

export function validatePermissionBoundary(snapshot, appId) {
  if (!Number.isSafeInteger(appId) || appId <= 0) unverified("app-id");
  if (!snapshot || typeof snapshot !== "object") unverified("snapshot");
  checkRepoRuleset(snapshot.ruleset, appId);
  if (need(snapshot.immutableReleases, "immutable", (v) => typeof v === "boolean") !== true) drift("immutable");
  const principals = need(snapshot.principals, "principals", isArray);
  const ownerId = need(snapshot.ownerId, "owner", Number.isSafeInteger);
  for (const principal of principals) {
    const permission = need(principal?.permission, "principals", (v) => typeof v === "string");
    const allowed = (principal.kind === "user" && principal.id === ownerId) || (principal.kind === "app" && principal.id === appId);
    if (WRITE.has(permission) && !allowed) drift("collaborators");
    if (!WRITE.has(permission) && !READ.has(permission)) unverified("principals");
  }
  // Org level (r4 Fable M5): murage-releases is org-owned, so the org base permission and any org ruleset count.
  const base = need(snapshot.orgBasePermission, "org-base", (v) => typeof v === "string");
  if (WRITE.has(base)) drift("org-base");
  if (!READ.has(base)) unverified("org-base");
  for (const org of need(snapshot.orgRulesets, "org-rulesets", isArray)) {
    if (need(org?.target, "org-rulesets", (v) => typeof v === "string") !== "tag" ||
        need(org.enforcement, "org-rulesets", (v) => typeof v === "string") !== "active") continue;
    const exclude = need(org.conditions?.ref_name?.exclude, "org-rulesets", isArray);
    if (exclude.length) drift("org-ruleset");
    const extra = need(org.bypass_actors, "org-rulesets", isArray).some((actor) => !(actor?.actor_type === "Integration" && actor.actor_id === appId));
    if (extra) drift("org-ruleset");
  }
  for (const key of need(snapshot.deployKeys, "deploy-key", isArray)) {
    if (need(key?.read_only, "deploy-key", (v) => typeof v === "boolean") !== true) drift("deploy-key");
  }
  for (const install of need(snapshot.installations, "installations", isArray)) {
    // Every installation needs a typed app id and a known contents level: a missing or unknown value is not "no access".
    const id = need(install?.app_id, "installations", Number.isSafeInteger);
    const contents = need(need(install.permissions, "installations", (v) => typeof v === "object").contents, "installations",
      (v) => typeof v === "string" && (WRITE.has(v) || READ.has(v)));
    if (id !== appId && WRITE.has(contents)) drift("installations");
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [appId] = process.argv.slice(2);
  console.log(JSON.stringify({ boundaryValid: validatePermissionBoundary(JSON.parse(readFileSync(0, "utf8")), Number(appId)) }));
}
