// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import { boundaryComms, boundaryStore } from "./boundary-ports.ts";
import { configureBotEgress } from "./bot-egress.ts";
import { delegateBotRoute, type DelegateBotRouteContext } from "./handoff-boundary.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { queueDelegation } from "./delegations.ts";
import { initializePendingDelegations } from "./pending-delegations-schema.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import type { PackAuthority } from "./delegation-pack/types.ts";
import type { CommsBus } from "./comms-visibility.ts";

vi.mock("./host-words.ts", async original => ({
  ...await original<typeof import("./host-words.ts")>(), authorizeStatus: () => ({ ok: true }),
}));
beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); });
afterEach(() => { configureBotEgress(undefined); closeMessageDb(); closeDatabase(); vi.restoreAllMocks(); });

function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const from = store.createBot({ name: "Sable" }, { seedMessages: false });
  const target = store.createBot({ name: "Ember" }, { seedMessages: false });
  const bus: CommsBus = { store, broadcast: () => {} };
  const caps = new InternalCapabilities();
  const generation = caps.begin(from.id, from.threadId);
  const token = caps.mint({ botId: from.id, threadId: from.threadId, generation, depth: 0, kind: "agents", skillAuthoring: false });
  const claim = caps.resolve(`Bearer ${token}`)!;
  let inputId: string | undefined;
  const input = (change: Partial<Message> = {}) => {
    inputId = store.appendMessage(from.threadId, { role: "user", kind: "text", text: "Ask Ember", origin: "desktop", ...change }).id;
  };
  const proof = vi.fn(() => inputId ? { messageId: inputId } : undefined);
  const comms = boundaryComms(bus);
  const queue = vi.spyOn(comms, "queueDelegation");
  const body: Record<string, unknown> = { fromBotId: from.id, fromThreadId: from.threadId, toBotId: target.id, message: "the note" };
  const context = {
    MAX_COMMS_DEPTH: 4, store: boundaryStore(store), comms,
    internalCapabilities: Object.assign(caps, { turnInputOf: proof }), internalClaim: claim,
    internalOwner: {}, ownerSurfacesByThread: new Map(), isUnattended: () => false,
    connectorThread: () => true, coordinationBudget: { advance: () => undefined },
    fullAccessSkipsPeerCard: () => false, roomAskDuplicate: () => null, roomAskParent: () => undefined,
    roomAskRefused: () => undefined, routinePeerSource: () => undefined, sourceExecutionAudience: () => undefined,
    beginRoomAsk: () => "fixture-request", resultEgressDeps: {}, taskResolutionDeps: {},
    eventAction: async (_spec: unknown, run: (handle: unknown) => unknown) => run({ charge: async () => {}, record: () => {}, unrun: () => {} }),
    readInternalBody: async () => body, res: {},
  } as unknown as DelegateBotRouteContext;
  const rows = () => database().prepare("SELECT * FROM pending_delegations ORDER BY rowid").all();
  const run = async () => {
    configureBotEgress(() => {});
    await delegateBotRoute(context);
    expect(queue).toHaveBeenCalled();
    return queue.mock.calls.at(-1)?.[4] as PackAuthority | undefined;
  };
  const enqueue = (authority?: PackAuthority, extra = {}) => queueDelegation(bus, from,
    { toBotId: target.id, message: "the note", depth: 0, ...extra }, 4, from.threadId, authority);
  return { store, from, target, bus, caps, context, generation, input, proof, body, run, rows, enqueue };
}

it.each(["desktop", "companion"] as const)("T-DE-ROOT: %s input roots only with authenticated generation proof", async origin => {
  const w = fixture(); w.input({ origin });
  await w.run(); expect(w.rows().at(-1)?.owner_rooted).toBe(1);
  w.proof.mockReturnValue(undefined);
  await w.run(); expect(w.rows().at(-1)?.owner_rooted).toBe(0);
});

it.each(["missing input", "unproven phone", "shared input", "stale generation"])(
  "T-DE-ROOT: %s cannot root a hand-off; kills skipping the input guard", async guard => {
    const w = fixture();
    const via = guard === "unproven phone" ? "ask-intent" : guard === "shared input" ? "share" : undefined;
    w.input({ via });
    await w.run(); expect(w.rows().at(-1)?.owner_rooted).toBe(1);
    if (guard === "missing input") w.proof.mockReturnValue({ messageId: "missing" });
    if (guard === "unproven phone" || guard === "shared input") w.input({ origin: "unproven", via });
    if (guard === "stale generation") vi.spyOn(w.caps, "activeGeneration").mockReturnValue("replacement");
    await w.run(); expect(w.rows().at(-1)?.owner_rooted).toBe(0);
  });

it.each(["room", "shared"] as const)("T-DE-ROOT: %s origin cannot root an otherwise authenticated hand-off", async origin => {
  const w = fixture(); w.input(); const authority = await w.run();
  expect(w.rows().at(-1)?.owner_rooted).toBe(1);
  w.bus.prepareDelegation = () => origin;
  expect(w.enqueue(authority).result).toBe("ok");
  expect(w.rows().at(-1)?.owner_rooted).toBe(0);
});

it.each(["bot", "thread"])("T-DE-ROOT: separate authority must match the source %s", async guard => {
  const w = fixture(); w.input(); const authority = (await w.run())!;
  expect(w.rows().at(-1)?.owner_rooted).toBe(1);
  const changed = { ...authority, ...(guard === "bot" ? { fromBotId: w.target.id } : { fromThreadId: w.target.threadId }) };
  expect(w.enqueue(changed).result).toBe("ok");
  expect(w.rows().at(-1)?.owner_rooted).toBe(0);
});

it("T-DE-ROOT: an optional pack failure does not remove authenticated owner rooting", async () => {
  const w = fixture(); w.input();
  await w.run(); expect(w.rows().at(-1)?.owner_rooted).toBe(1);
  database().exec("CREATE TRIGGER refuse_pack BEFORE INSERT ON delegation_packs BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  await w.run(); expect(w.rows().at(-1)?.owner_rooted).toBe(1);
  expect(database().prepare("SELECT count(*) AS n FROM delegation_packs").get()?.n).toBe(1);
});

it.each(["ownerRooted", "owner_rooted"])("T-DE-FORGE: %s in tool arguments cannot replace server authority", async key => {
  const w = fixture(); w.input(); w.body[key] = true;
  await w.run(); expect(w.rows().at(-1)?.owner_rooted).toBe(1);
  w.proof.mockReturnValue(undefined);
  await w.run(); expect(w.rows().at(-1)?.owner_rooted).toBe(0);
  expect(JSON.parse(String(w.rows().at(-1)?.item))[key]).toBeUndefined();
});

it.each(["ownerRooted", "owner_rooted"])("T-DE-FORGE: %s in item JSON cannot root the column", async key => {
  const w = fixture(); w.input(); const authority = await w.run();
  expect(w.enqueue(authority, { [key]: true }).result).toBe("ok");
  expect(w.rows().at(-1)?.owner_rooted).toBe(1);
  expect(w.enqueue(undefined, { [key]: true }).result).toBe("ok");
  expect(w.rows().at(-1)?.owner_rooted).toBe(0);
});

it("T-DE-ROOT: owner rooting rolls back with the queue transaction", async () => {
  const w = fixture(); w.input(); const authority = await w.run();
  expect(w.rows().at(-1)?.owner_rooted).toBe(1);
  expect(() => transaction(() => {
    expect(w.enqueue(authority).result).toBe("ok");
    expect(w.rows()).toHaveLength(2);
    expect(w.rows().at(-1)?.owner_rooted).toBe(1);
    throw new Error("rollback");
  })).toThrow("rollback");
  expect(w.rows()).toHaveLength(1);
});

it.each(["fresh", "current migration", "old rebuild"])("T-DE-ROOT: %s schema defaults old rows to zero and matches the snapshot reference", kind => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeMessageTables(db);
    initializePendingDelegations(db);
    const column = db.prepare("PRAGMA table_info(pending_delegations)").all().find(row => row.name === "owner_rooted");
    expect(column).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "0" });
    if (kind !== "fresh") db.exec("ALTER TABLE pending_delegations DROP COLUMN owner_rooted");
    if (kind === "old rebuild") db.exec("ALTER TABLE pending_delegations DROP COLUMN evidence_at");
    db.prepare("INSERT INTO pending_delegations(id,source_thread_id,to_bot_id,phase,item,origin) VALUES('old','source','target','fresh',?,'owner')")
      .run(JSON.stringify({ ownerRooted: true, owner_rooted: 1 }));
    initializePendingDelegations(db);
    expect(db.prepare("SELECT owner_rooted FROM pending_delegations").get()?.owner_rooted).toBe(0);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.exec("UPDATE pending_delegations SET owner_rooted=1");
    initializePendingDelegations(db);
    expect(db.prepare("SELECT owner_rooted FROM pending_delegations").get()?.owner_rooted).toBe(1);
    expect(() => db.exec("UPDATE pending_delegations SET owner_rooted=NULL")).toThrow();
  } finally { db.close(); }
});
