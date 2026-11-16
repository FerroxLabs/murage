// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: sc-safety. Store owns method behavior; this port owns fixture completeness.
import { afterEach } from "vitest";
import { Store, type BotRecord, type GroupRecord } from "../store.ts";
import { setExecutionStore, type ExecutionStorePort } from "../execution-audience.ts";
const stores = new Set<Store>();
const fixtures = new WeakSet<object>();
export const isExecutionStoreFixture = (value: unknown): boolean => !!value && typeof value === "object" && fixtures.has(value);
afterEach(() => { for (const store of stores) store.stopSeqStamps(); stores.clear(); setExecutionStore(undefined); });

/** DATA_DIR is the isolated Vitest installation, never the user's store. */
export function executionStoreFixture(roster?: { bots: BotRecord[]; groups: GroupRecord[] }) {
  const store = new Store(); stores.add(store);
  if (roster) { store.bots = roster.bots; store.groups = roster.groups; }
  const fixture = {
    get bots() { return store.bots; }, get groups() { return store.groups; },
    bot: store.bot.bind(store), group: store.group.bind(store),
    taskByThread: store.taskByThread.bind(store), threadIdsForBot: store.threadIdsForBot.bind(store),
    createTask: store.createTask.bind(store), patchTask: store.patchTask.bind(store),
    createSharedWorkTask: store.createSharedWorkTask.bind(store), ensureProjectDesk: store.ensureProjectDesk.bind(store),
    projectBotForTask: store.projectBotForTask.bind(store), activeTextLines: store.activeTextLines.bind(store),
    releaseTaskProcedures: store.releaseTaskProcedures.bind(store), releaseGroupProcedures: store.releaseGroupProcedures.bind(store),
  } satisfies ExecutionStorePort;
  Object.freeze(fixture);
  fixtures.add(fixture);
  return fixture;
}
