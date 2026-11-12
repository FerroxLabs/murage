import { inertBot } from "../store.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The production HighLevel runtime (HL-S2, GAP-HIGHLEVEL-109 sections 7, 8 and 9.3): one host, its durable action
// journal and the connection source, built once by index.ts.
//
// Fail closed everywhere:
//   - No connection source (the broker and the owner token path are later slices) means every connection reads as
//     absent: a call answers "not connected", no lease is ever requested and nothing reaches the network.
//   - A journal that cannot be read holds every change (propose answers "could not be recorded"); reads still work.
//   - At boot, recover() runs with no review values (they are never written to disk): an open review goes stale, and
//     a change that may have been sent becomes outcome_unknown. Nothing is resent.
import { UserCreateIdentityClaims } from "./users-create-identity.ts";
import type { HighLevelHostDeps } from "./host.ts";
import { canonicalBindingJson } from './binding-json.ts';
import { join } from "node:path";
import { FileApprovalJournal, type ApprovalJournal } from "./approval-idempotency.ts";
import { FileRpcApprovalJournal, type RpcApprovalJournal } from "./rpc-approval-replay.ts";
import type { InternalCapability } from "../internal-capabilities.ts";
import { nativeAccessFor, type HighLevelAccessBot } from "./access.ts";
import { HighLevelActions, type ActionIntent, type ActionJournal } from "./actions.ts";
import { HIGHLEVEL_FAMILIES, HIGHLEVEL_TOOL_NAMES, HIGHLEVEL_READ_TOOL_NAMES, HIGHLEVEL_TOOLKIT, LEGACY_TOOL_TO_OPERATION, effectiveHighLevelAccess, highlevelFamiliesSchema, nativeGrantSchema, levelCovers, highlevelDenyRulesSchema, type Family, type FamilyLevel, type NativeGrant } from "../../shared/highlevel.ts";
import { HighLevelClient, HighLevelError, type HighLevelConnectionView, type HighLevelLease, type HighLevelLeaseSource } from "./client.ts";
import { accessRoleBinding } from "../bot-access-role.ts";
import { HighLevelHost, type HighLevelTurnSignals } from "./host.ts";
import { FileActionJournal, defaultHighLevelJournalFile } from "./journal-file.ts";
import type { HighLevelThreadMarkState } from "./thread-marks.ts";
import { highlevelOfferedOn, HIGHLEVEL_ENGINE_OWNER_LINE } from "./offered.ts";
import type { HighLevelOwnerConnection } from "./private-token.ts";
import { HIGHLEVEL_ENDPOINTS, HIGHLEVEL_PERMISSION_NAMES } from "./provider-contract.ts";

export const HIGHLEVEL_NOT_CONNECTED = "HighLevel is not connected in this workspace.";

/** No connection anywhere: the default until an owner connects a location. */
export class NotConnectedLeaseSource implements HighLevelLeaseSource {
  async connection(_connectionId: string): Promise<HighLevelConnectionView | undefined> { return undefined; }
  async lease(): Promise<HighLevelLease> { throw new HighLevelError(HIGHLEVEL_NOT_CONNECTED, { status: 409 }); }
}

/** Stands in when the journal file cannot be read: nothing can be recorded, so nothing can be sent. */
export class HeldActionJournal implements ActionJournal {
  put(_intent: ActionIntent): void { throw new Error("HighLevel journal held"); }
  delete(_actionId: string): void { throw new Error("HighLevel journal held"); }
  all(): ActionIntent[] { return []; }
}

/** Compatibility parser for old clients. Family-level grants use ownerGrant below;
 * old tool-list requests remain read-only and cannot silently gain new operations. */
export function ownerReadGrant(item: unknown, input: { connectionId: string; botId: string; revision: number }):
  { ok: true; grant: NativeGrant } | { ok: false; error: string } {
  const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
  if (row.ceiling !== "read") return { ok: false, error: "HighLevel access is read only." };
  const tools = Array.isArray(row.tools) ? [...new Set(row.tools)] : [];
  if (tools.length === 0 || !tools.every((tool) => (HIGHLEVEL_READ_TOOL_NAMES as readonly unknown[]).includes(tool))) {
    return { ok: false, error: "Choose at least one HighLevel read tool from the list." };
  }
  return { ok: true, grant: { toolkit: HIGHLEVEL_TOOLKIT, accountId: input.connectionId, tools: tools as NativeGrant["tools"], botId: input.botId, revision: input.revision, ceiling: "read" } };
}

export interface HighLevelRuntimeOptions {
  dataDir: string;
  userCreateOwner?: HighLevelHostDeps["userCreateOwner"];
  capabilities: { isActive(claim: InternalCapability): boolean };
  threadMarkState(threadId: string): HighLevelThreadMarkState;
  signals: HighLevelTurnSignals;
  bot(botId: string): HighLevelAccessBot | undefined;
  leases?: HighLevelLeaseSource;
  journal?: ActionJournal;
  fetch?: typeof fetch;
  onJournalHeld?: (error: unknown) => void;
  /** Trusted connection scope inventory, re-read before dispatch. */
  operationScopes?: (connectionId: string) => readonly string[] | undefined;
}

export function createHighLevelRuntime(options: HighLevelRuntimeOptions) {
  let journal = options.journal;
  let journalHeld = false;
  if (!journal) {
    try { journal = new FileActionJournal(defaultHighLevelJournalFile(options.dataDir)); }
    catch (error) { journal = new HeldActionJournal(); journalHeld = true; options.onJournalHeld?.(error); }
  }
  const actions = new HighLevelActions({ journal });
  try { actions.recover(); } catch (error) { journalHeld = true; options.onJournalHeld?.(error); }
  const leases = options.leases ?? new NotConnectedLeaseSource();
  const client = new HighLevelClient({ leases, ...(options.fetch ? { fetch: options.fetch } : {}) });
  // All live readers use the effective grant: legacy rows stay read-only, v2 retains the owner's family levels.
  const bot = (botId: string): HighLevelAccessBot | undefined => {
    const stored = options.bot(botId);
    return stored && stored.highlevelAccess !== undefined ? { ...stored, highlevelAccess: effectiveHighLevelAccess(stored.highlevelAccess, { id: stored.id, roleBinding: accessRoleBinding(stored) }) } : stored;
  };
  // Re-read at every native authorization boundary, including already-mounted
  // capabilities and post-await checks before provider dispatch/result release.
  const capabilities = { isActive(claim: InternalCapability): boolean {
    try { return options.threadMarkState(claim.threadId) === "marked" && options.capabilities.isActive(claim); }
    catch { return false; }
  } };
  let approvalJournal: RpcApprovalJournal | undefined, callJournal: ApprovalJournal | undefined;
  try {
    approvalJournal = new FileRpcApprovalJournal(join(options.dataDir, "highlevel", "approvals"));
    // Both pre-integration names are read-only legacy indices. Expose one
    // dependency so neither lane can miss an old claim and resend its write.
    const legacy = ['calls', 'tool-calls'].map(name => new FileApprovalJournal(join(options.dataDir, 'highlevel', name)));
    callJournal = {
      key: join(options.dataDir, 'highlevel', 'legacy-calls'),
      get(id) {
        const rows = legacy.map(journal => journal.get(id)).filter(row => row !== undefined);
        if (rows.length > 1 && canonicalBindingJson(rows[0]) !== canonicalBindingJson(rows[1])) throw new Error('Conflicting legacy tool-call records');
        return rows[0];
      },
      claim() { throw new Error('Legacy tool-call journals are read only'); },
      settle() { throw new Error('Legacy tool-call journals are read only'); },
    };
  } catch (error) { journalHeld = true; options.onJournalHeld?.(error); }
  let userCreateClaims: UserCreateIdentityClaims | undefined;
  try { userCreateClaims = new UserCreateIdentityClaims(join(options.dataDir, "highlevel", "user-create-claims.sqlite")); }
  catch (error) { options.onJournalHeld?.(error); }
  const host = new HighLevelHost({ operationScopes: options.operationScopes, userCreateOwner: options.userCreateOwner, userCreateClaims, approvalJournal, callJournal, capabilities, signals: options.signals, bot, leases, client, actions });

  /** Whether this bot's turn should mount the HighLevel tools at all: connected apps on, at least one native grant,
   * and at least one granted connection that can carry a call now. The host checks everything again per call. */
  async function mountsFor(botId: string): Promise<boolean> {
    const current = bot(botId);
    if (!current || inertBot(current) || current.composio === false) return false;
    const grants = nativeAccessFor(current)?.grants ?? [];
    for (const grant of grants.slice(0, 50)) {
      const view = await leases.connection(grant.accountId);
      if (view && (view.state === "connected" || view.state === "degraded")) return true;
    }
    return false;
  }

  function endConnection(connectionId: string, code = "connection_changed"): void {
    actions.staleConnection(connectionId, code);
  }

  return { host, actions, leases, client, mountsFor, endConnection, userCreateClaims, close: () => userCreateClaims?.close(), get journalHeld() { return journalHeld; } };
}

export type HighLevelRuntime = ReturnType<typeof createHighLevelRuntime>;

/** Owner grant validation and status projection adapted from 6a04f7080. Family
 * levels, desktop proof and the monotonically increasing revision are authority;
 * legacy tools are a compatibility projection, never a second source of access. */
export function ownerGrant(item: unknown, input: { connectionId: string; botId: string; revision: number }):
  { ok: true; grant: NativeGrant } | { ok: false; error: string } {
  if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: "Choose HighLevel access from the list." };
  const row = item as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["connectionId", "families", "operations", "tools", "ceiling", "broaden"].includes(key))) return { ok: false, error: "Choose HighLevel access from the list." };
  if (row.families === undefined) {
    // Old clients may save read grants, never upgrade through the old ceiling.
    const checked = ownerReadGrant(item, input);
    if (!checked.ok) return checked;
    const value = effectiveHighLevelAccess({ revision: input.revision, roleBinding: "owner", grants: [checked.grant] }, { id: input.botId, roleBinding: "owner" })!;
    return { ok: true, grant: { ...checked.grant, families: { ...value.grants[0]!.families }, operations: value.grants[0]!.operations as NativeGrant["operations"] } };
  }
  const parsed = highlevelFamiliesSchema.safeParse(row.families);
  if (!parsed.success) return { ok: false, error: "Choose Off, Can look, Can change or Full control for each family." };
  const families = parsed.data;
  const tools = HIGHLEVEL_TOOL_NAMES.filter((tool) => {
    const operation = LEGACY_TOOL_TO_OPERATION[tool]!;
    const restriction = Array.isArray(row.operations) ? row.operations : row.operations && typeof row.operations === "object" ? (row.operations as Record<string, unknown>)[operation.split(".")[0]!] : undefined;
    return levelCovers(families[operation.split(".")[0] as Family], HIGHLEVEL_READ_TOOL_NAMES.includes(tool) ? "R" : "C") &&
      (restriction === undefined || (Array.isArray(restriction) && restriction.includes(operation)));
  });
  const grant = nativeGrantSchema.safeParse({ toolkit: HIGHLEVEL_TOOLKIT, accountId: input.connectionId, botId: input.botId, revision: input.revision,
    families, tools, ceiling: Object.values(families).some((level) => level === "change" || level === "full") ? "propose" : "read",
    ...(row.operations !== undefined ? { operations: row.operations } : {}),
  });
  return grant.success ? { ok: true, grant: grant.data } : { ok: false, error: "Choose HighLevel operations from the list." };
}

export function highlevelGrantUpdate(rows: unknown[], input: {
  connection: HighLevelOwnerConnection | null; botId: string; revision: number; driverKind: string | undefined; desktop: boolean;
  previous?: unknown; roleBinding?: string; denyRules?: unknown;
}): { ok: true; grants: NativeGrant[]; denyRules: string[] } | { ok: false; status: 400 | 403 | 409; body: { error: string; code?: string } } {
  const previous = effectiveHighLevelAccess(input.previous, { id: input.botId, roleBinding: input.roleBinding ?? "owner" });
  const rules = highlevelDenyRulesSchema.safeParse(input.denyRules === undefined ? previous?.denyRules ?? [] : input.denyRules);
  if (!rules.success) return { ok: false, status: 400, body: { error: "Choose valid HighLevel review rules." } };
  if (!input.desktop && previous?.denyRules.some(rule => !rules.data.includes(rule))) return { ok: false, status: 403, body: { code: "on_computer", error: "Remove HighLevel review rules from Murage on your computer." } };
  if (rows.length > 1) return { ok: false, status: 400, body: { error: "Choose at most one HighLevel location." } };
  if (rows.length === 0) return { ok: true, grants: [], denyRules: rules.data };
  if (!highlevelOfferedOn(input.driverKind)) return { ok: false, status: 409, body: { error: HIGHLEVEL_ENGINE_OWNER_LINE, code: "engine_unsupported" } };
  const row = rows[0] && typeof rows[0] === "object" ? rows[0] as Record<string, unknown> : {};
  if (!input.connection || row.connectionId !== input.connection.connectionId) return { ok: false, status: 409, body: { error: "Confirm the HighLevel location first, then choose what this bot may do there." } };
  const aboveRead = row.ceiling === "propose" || (row.families && typeof row.families === "object" && Object.values(row.families).some(level => level === "change" || level === "full")) ||
    (Array.isArray(row.tools) && row.tools.some(tool => HIGHLEVEL_TOOL_NAMES.includes(tool) && !HIGHLEVEL_READ_TOOL_NAMES.includes(tool)));
  if (aboveRead && !input.desktop) return { ok: false, status: 403, body: { code: "on_computer", error: "Turn this on from Murage on your computer." } };
  // R4-PROVISIONAL / PROVISIONAL INTERFACE: request-level explicit family broadening.
  const broaden = row.broaden ?? {};
  if (!broaden || typeof broaden !== "object" || Array.isArray(broaden) || Object.entries(broaden).some(([family, yes]) => !HIGHLEVEL_FAMILIES.includes(family as Family) || yes !== true)) return { ok: false, status: 400, body: { error: "Choose the families to broaden." } };
  const checked = ownerGrant(row, { connectionId: input.connection.connectionId, botId: input.botId, revision: input.revision });
  if (!checked.ok) return { ok: false, status: 400, body: { error: checked.error } };
  const old = previous?.grants.find(grant => grant.accountId === input.connection!.connectionId);
  const requested = checked.grant.operations;
  const operations: Partial<Record<Family, readonly import("../../shared/highlevel.ts").OperationId[]>> = { ...old?.operations };
  for (const family of HIGHLEVEL_FAMILIES) {
    // An off family authorized no operations. An unrelated save must not turn
    // an absent restriction into all reads when the UI supplies default levels.
    if (old?.families[family] === "off" && operations[family] === undefined) operations[family] = [];
    if ((broaden as Record<string, unknown>)[family] && checked.grant.families?.[family] !== "off") delete operations[family];
    const allowed = Array.isArray(requested) ? requested.filter(op => op.startsWith(family + ".")) : requested?.[family];
    if (allowed !== undefined) operations[family] = operations[family] === undefined ? allowed : allowed.filter(op => operations[family]!.includes(op));
  }
  const grant = { ...checked.grant, operations: operations as NativeGrant["operations"] };
  return { ok: true, grants: [grant], denyRules: rules.data };
}

export interface HighLevelFamilyScopes {
  present: string[]; missing: string[]; missingNames: string[]; canRead: boolean; canChange: boolean; canFull: boolean;
}
/** The frozen provider endpoints supply each family's permission inventory.
 * Verified scopes come from the connection source, never the request body. Empty/unknown
 * scope inventories and families absent from the manifest cannot enable changes. */
export function highlevelFamilyScopes(verifiedScopes: readonly string[], endpoints: Readonly<Record<string, { scope: string; retry: string; family?: string; risk?: string }>> = HIGHLEVEL_ENDPOINTS): Record<Family, HighLevelFamilyScopes> {
  const scopes = new Set(verifiedScopes);
  return Object.fromEntries(HIGHLEVEL_FAMILIES.map((family) => {
    const entries = Object.entries(endpoints).filter(([operation, endpoint]) => {
      const prefix = endpoint.family ?? operation.split(".")[0];
      return (prefix === "locations" ? "location" : prefix === "pipelines" ? "opportunities" : prefix) === family;
    }).map(([, endpoint]) => endpoint);
    const needed = [...new Set(entries.map((entry) => entry.scope))].sort();
    const reads = entries.filter((entry) => entry.risk ? entry.risk === "R" : entry.retry === "read");
    const writes = entries.filter((entry) => entry.risk ? entry.risk !== "R" : entry.retry === "write");
    const missing = needed.filter((scope) => !scopes.has(scope));
    const covers = (rows: typeof entries) => rows.length > 0 && rows.every((entry) => scopes.has(entry.scope));
    return [family, { present: needed.filter((scope) => scopes.has(scope)), missing,
      missingNames: missing.map((scope) => HIGHLEVEL_PERMISSION_NAMES[scope] ?? scope),
      canRead: covers(reads), canChange: covers(writes), canFull: covers(writes) && missing.length === 0 }];
  })) as Record<Family, HighLevelFamilyScopes>;
}

/** PROVISIONAL INTERFACE: PIT currently proves only View Locations. A future
 * verified connection source may expose scopes; an opaque token is not evidence
 * of write permission and is never decoded or sent to a new endpoint here. */
export function highlevelVerifiedScopes(connection: (HighLevelOwnerConnection & { scopes?: readonly string[] }) | null): readonly string[] {
  if (!connection || !["connected", "degraded"].includes(connection.state)) return [];
  return Array.isArray(connection.scopes) && connection.scopes.every((scope) => typeof scope === "string") ? connection.scopes : ["locations.readonly"];
}

export function highlevelStatusBody(input: {
  desktop: boolean; tokenSaved: boolean; connection: HighLevelOwnerConnection | null; journalHeld: boolean;
  bots: ReadonlyArray<{ id: string; roleBinding?: string; hidden?: boolean; highlevelAccess?: unknown; driverKind: string | undefined }>;
}): Record<string, unknown> {
  const bots = input.bots.filter((bot) => !bot.hidden).map((bot) => {
    const access = effectiveHighLevelAccess(bot.highlevelAccess, { id: bot.id, roleBinding: bot.roleBinding ?? "" });
    const families = access?.grants.find((grant) => grant.accountId === input.connection?.connectionId)?.families;
    const levels = Object.values(families ?? {});
    const level: FamilyLevel = levels.includes("full") ? "full" : levels.includes("change") ? "change" : levels.includes("read") ? "read" : "off";
    return { botId: bot.id, offered: highlevelOfferedOn(bot.driverKind), level, ...(input.desktop && access ? { access } : {}) };
  });
  return { redacted: !input.desktop, tokenSaved: input.tokenSaved, connection: input.connection ? {
    connectionId: input.connection.connectionId, locationId: input.connection.locationId, locationName: input.connection.locationName,
    state: input.connection.state, confirmedAt: input.connection.confirmedAt,
  } : null, journalHeld: input.journalHeld, bots,
    ...(input.desktop ? { familyScopes: highlevelFamilyScopes(highlevelVerifiedScopes(input.connection)) } : {}),
  };
}
