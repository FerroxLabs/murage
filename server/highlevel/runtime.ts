// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The production HighLevel runtime (HL-S2, GAP-HIGHLEVEL-109 sections 7, 8 and 9.3): one host, its durable action
// journal and the connection source, built once by index.ts.
//
// HL-S2 is read-only (MurageMain 11-04). The host sees every bot through readOnlyHighLevelAccess, so each grant is
// "read" with its change tools removed: no change tool is listed, every change call is refused before anything is
// recorded, and there is no owner review card. Changes are row HL-S2-WRITES-DESIGN.
//
// Fail closed everywhere:
//   - No connection source (the broker and the owner token path are later slices) means every connection reads as
//     absent: a call answers "not connected", no lease is ever requested and nothing reaches the network.
//   - A journal that cannot be read holds every change (propose answers "could not be recorded"); reads still work.
//   - At boot, recover() runs with no review values (they are never written to disk): an open review goes stale, and
//     a change that may have been sent becomes outcome_unknown. Nothing is resent.
import type { InternalCapability } from "../internal-capabilities.ts";
import { nativeAccessFor, type HighLevelAccessBot } from "./access.ts";
import { HighLevelActions, type ActionIntent, type ActionJournal } from "./actions.ts";
import { HIGHLEVEL_READ_TOOL_NAMES, HIGHLEVEL_TOOLKIT, readOnlyHighLevelAccess, type NativeGrant } from "../../shared/highlevel.ts";
import { HighLevelClient, HighLevelError, type HighLevelConnectionView, type HighLevelLease, type HighLevelLeaseSource } from "./client.ts";
import { HighLevelHost, type HighLevelTurnSignals } from "./host.ts";
import { FileActionJournal, defaultHighLevelJournalFile } from "./journal-file.ts";

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

/** One grant row from the owner's PUT /api/highlevel/bots/:botId/access, for the confirmed connection. HL-S2 is read only:
 * any ceiling but "read", and any tool that is not one of the twelve read tools, is refused, so a change grant is never
 * saved. */
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
  capabilities: { isActive(claim: InternalCapability): boolean };
  signals: HighLevelTurnSignals;
  bot(botId: string): HighLevelAccessBot | undefined;
  leases?: HighLevelLeaseSource;
  journal?: ActionJournal;
  fetch?: typeof fetch;
  onJournalHeld?: (error: unknown) => void;
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
  // Every reader of a bot's HighLevel access (the host, the mount check) goes through this: read-only, whatever is stored.
  const bot = (botId: string): HighLevelAccessBot | undefined => {
    const stored = options.bot(botId);
    return stored && stored.highlevelAccess !== undefined ? { ...stored, highlevelAccess: readOnlyHighLevelAccess(stored.highlevelAccess) } : stored;
  };
  const host = new HighLevelHost({ capabilities: options.capabilities, signals: options.signals, bot, leases, client, actions });

  /** Whether this bot's turn should mount the HighLevel tools at all: connected apps on, at least one native grant,
   * and at least one granted connection that can carry a call now. The host checks everything again per call. */
  async function mountsFor(botId: string): Promise<boolean> {
    const current = bot(botId);
    if (!current || current.hidden || current.composio === false) return false;
    const grants = nativeAccessFor(current)?.grants ?? [];
    for (const grant of grants.slice(0, 50)) {
      const view = await leases.connection(grant.accountId);
      if (view && (view.state === "connected" || view.state === "degraded")) return true;
    }
    return false;
  }

  return { host, actions, leases, client, mountsFor, get journalHeld() { return journalHeld; } };
}

export type HighLevelRuntime = ReturnType<typeof createHighLevelRuntime>;
