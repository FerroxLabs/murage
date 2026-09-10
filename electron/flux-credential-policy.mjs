import { createHash } from "node:crypto";
import { assertProviderKey, parseProviderBank } from "./provider-connections.mjs";

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
/** Private snapshot only. Aliases contain no credentials and are never user input. */
function snapshot(state) {
  const bank = parseProviderBank(state.bank);
  const workspaceKey = (state.workspaceKey ?? "").trim();
  const aliases = structuredClone(state.aliases ?? []);
  if (!Array.isArray(aliases) || aliases.length > 1024) fail("Saved Flux connections are invalid.");
  const ids = new Set(bank.map(row => row.id));
  for (const alias of aliases) {
    if (!alias || Object.keys(alias).some(key => !["id", "label", "enabled", "revision"].includes(key)) || !validId(alias.id) || alias.id === "legacy-flux" || ids.has(alias.id) || typeof alias.label !== "string" || !alias.label.trim() || alias.label.length > 80 || /[\x00-\x1f]/.test(alias.label) || typeof alias.enabled !== "boolean" || !validId(alias.revision)) fail("Saved Flux connections are invalid.");
    ids.add(alias.id);
  }
  if (bank.some(row => ["legacy-flux", "legacy-flux-file", "legacy-flux-environment"].includes(row.id))) fail("Saved Flux connection identity conflicts with the workspace connection.");
  const fileWorkspaceKey = (state.fileWorkspaceKey ?? "").trim();
  const ambientWorkspaceKey = (state.ambientWorkspaceKey ?? "").trim();
  return { bank, workspaceKey, aliases, fileWorkspaceKey, ambientWorkspaceKey };
}
export function fluxCredentialRevision(state) {
  return createHash("sha256").update(JSON.stringify(snapshot(state))).digest("hex");
}
export function fluxCredentialStatus(state) {
  const saved = snapshot(state);
  const rows = saved.bank.filter(row => row.preset === "flux");
  const choices = [ ...(saved.workspaceKey ? [{ id: "legacy-flux", label: "Existing workspace key", enabled: true }] : []), ...(saved.fileWorkspaceKey && saved.fileWorkspaceKey !== saved.workspaceKey ? [{ id: "legacy-flux-file", label: "Existing configuration key", enabled: true }] : []), ...(saved.ambientWorkspaceKey && saved.ambientWorkspaceKey !== saved.workspaceKey && saved.ambientWorkspaceKey !== saved.fileWorkspaceKey ? [{ id: "legacy-flux-environment", label: "Existing environment key", enabled: true }] : []), ...rows.map(({ id, label, enabled }) => ({ id, label, enabled })) ];
  const keys = new Set([saved.workspaceKey, saved.fileWorkspaceKey, saved.ambientWorkspaceKey, ...rows.map(row => row.key.trim())].filter(Boolean));
  return { configured: Boolean(saved.workspaceKey), revision: fluxCredentialRevision(state), conflict: keys.size > 1, choices };
}
/** Caller must fence active work, then atomically persist all three returned fields. */
export function planFluxCredentialChange(state, input) {
  const saved = snapshot(state), status = fluxCredentialStatus(state);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["action", "revision", "key", "connectionId"].includes(key))) fail("Invalid Flux connection change.");
  if (input.revision !== status.revision) fail("Flux connections changed. Refresh before saving.", 409);
  if (!["connect", "replace", "select", "disconnect", "consolidate"].includes(input.action)) fail("Choose a Flux connection action.");
  if (input.action !== "select" && input.connectionId !== undefined || !["connect", "replace"].includes(input.action) && input.key !== undefined) fail("Invalid Flux connection change.");
  const rows = saved.bank.filter(row => row.preset === "flux");
  let workspaceKey = saved.workspaceKey;
  if (input.action === "disconnect") workspaceKey = "";
  else if (input.action === "select") {
    const selected = input.connectionId === "legacy-flux" ? saved.workspaceKey : input.connectionId === "legacy-flux-file" ? saved.fileWorkspaceKey : input.connectionId === "legacy-flux-environment" ? saved.ambientWorkspaceKey : rows.find(row => row.id === input.connectionId)?.key;
    if (!selected) fail("Choose an existing Flux connection.");
    workspaceKey = selected.trim();
  } else {
    if (status.conflict) fail("Choose which existing Flux key to keep before changing it.", 409);
    if (input.action === "connect" && status.choices.length) fail("Flux is already saved. Replace or select its key.", 409);
    if (input.action === "replace" && !status.choices.length) fail("Connect Flux before replacing its key.", 409);
    if (input.action === "consolidate") {
      if (!workspaceKey && (saved.fileWorkspaceKey || saved.ambientWorkspaceKey)) fail("Select a saved Flux key before enabling it.", 409);
      if (!workspaceKey && rows.length && !rows.some(row => row.enabled)) fail("Select a saved Flux key before enabling it.", 409);
      workspaceKey ||= rows.find(row => row.enabled)?.key.trim() ?? "";
    } else {
      assertProviderKey("flux", input.key);
      workspaceKey = input.key.trim();
    }
  }
  const aliases = [...saved.aliases, ...rows.map(({ id, label, enabled, revision }) => ({ id, label, enabled, revision }))];
  if (aliases.length > 1024) fail("Too many saved Flux connection identities.");
  return { workspaceKey, bank: JSON.stringify(saved.bank.filter(row => row.preset !== "flux")), aliases };
}
/** Identity remains stable for historical native sessions; keys never live in aliases. */
export function resolveFluxAlias(alias, workspaceKey, canonicalRevision) {
  if (!workspaceKey?.trim()) return null;
  return { ...alias, preset: "flux", key: workspaceKey.trim(), revision: createHash("sha256").update(JSON.stringify([alias.revision, canonicalRevision])).digest("hex") };
}
