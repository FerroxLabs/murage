// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Crash fixture of server/boot-settle-109.crash.test.ts: a process that builds the fixture world on the test's data directory (a real one: the server
// starts on it afterwards), runs ONE real path with a seam that prints `REACHED <point>` and dies (exit 9) at the named point. The seams are the paths'
// own injected dependencies, not production hooks. The `inspect:*` and `replay:*` scenarios read a COPY of the data directory for the test.
// Usage: boot-settle-109-child.ts <card:after-unread:group|card:after-unread:task|venue:after-move|readonly:fixture|inspect:card:group|inspect:card:task|
//   inspect:venue|replay:card:group|replay:card:task>
const [scenario = ""] = process.argv.slice(2);
const dataDir = process.env.MURAGE_DATA_DIR;
if (!dataDir || !process.env.BOOT_SETTLE_109_CHILD) { process.stderr.write("refusing: not started by the boot-settle-109 test\n"); process.exit(2); }
const { closeDatabase, database, transaction } = await import("../database.ts");
const { flushCoalesced } = await import("../atomic.ts");
const { Store } = await import("../store.ts");
const { RoutineManager } = await import("../routines.ts");
const { writeRoutineRunCard } = await import("../routine-run-card.ts");
const { recoverAndSettleVenuePosts, heldVenuePost, holdVenuePost, moveVenuePost, setVenuePostCard } = await import("../venue-post-held.ts");
const { buildCardWorld, cardWorld, cardDeps } = await import("./boot-settle-109-world.ts");
type RoutineRun = import("../routines.ts").RoutineRun;
type WatchSource = import("../../shared/routine-watch.ts").RoutineWatchSource;
const die = (point: string): never => { process.stdout.write(`REACHED ${point}\n`); process.exit(9); };
const kindOf = (name: string) => name.endsWith("group") ? "group" as const : "task" as const;
const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
const db = database();
const VENUE_POST = "vpost-a";

/** The real routine store on this data directory. The watched file is the injected source: two different readings, so the second check reports a change. */
function routineStore(now: () => number, onRunChanged: (run: RoutineRun) => void = () => {}) {
  let reads = 0;
  return new RoutineManager({
    now, botState: () => "ready" as const, createTask: () => null, startTurn: async () => {},
    validateWatchSource: () => {}, readWatchSource: async (_owner: string, _bot: string, _source: WatchSource) => ({ fingerprint: (reads++ === 0 ? "a" : "b").repeat(64) }),
    onRunChanged,
  });
}
/** A bot with its task and a room; a venue post held from the task for the room, its card in the task, its line already in the room; cut short at `posting`. */
function buildVenueWorld() {
  buildCardWorld(store, "group");
  const world = cardWorld(store, "group"), task = cardWorld(store, "task");
  const card = store.appendMessage(task.threadId, { role: "bot", kind: "activity", text: "wants to post", card: { title: "Post it?" } } as never);
  store.appendMessage(world.threadId, { role: "bot", kind: "text", text: "Hello room" }, VENUE_POST);
  flushCoalesced();
  holdVenuePost(db, { id: VENUE_POST, botId: world.bot.id, threadId: task.threadId, origin: "desktop", requestMessageId: "m1", requestHash: "h", venueId: world.group!.id, targetThreadId: world.threadId, text: "Hello room", stableId: VENUE_POST, lineage: "[]" });
  setVenuePostCard(db, VENUE_POST, card.id);
  moveVenuePost(db, VENUE_POST, "held", "posting");
}

if (scenario.startsWith("card:after-unread:")) {
  const kind = kindOf(scenario);
  buildCardWorld(store, kind);
  flushCoalesced();
  const world = cardWorld(store, kind);
  // a confirmed file watch asked for in this chat, two checks: the first is the baseline, the second finds the file changed and ends the watch
  let now = Date.now() - 11 * 60_000;
  const routines = routineStore(() => now, (run) => {
    if (run.watch?.outcome !== "changed") return;
    // the run is saved; its card is written as the server writes it. The unread mark is written; the card's write is the next call, and it never happens
    writeRoutineRunCard(run, world.source, cardDeps(store, [], { appendMessage: () => die("card:after-unread") }));
  });
  const asked = store.appendMessage(world.threadId, { role: "bot", kind: "text", text: "Watch status.txt" });
  flushCoalesced();
  routines.create(
    { name: "File status", prompt: "Report changes", target: "bot", botId: world.bot.id, runOn: "ember", enabled: true, schedule: { type: "interval", everyMinutes: 5, anchorAt: now },
      watch: { source: { adapterId: "file", sourceId: "status.txt", scopeId: "0".repeat(64) }, expiresAt: Date.now() + 86_400_000, maxChecks: 2 } },
    { requestId: "request-fixture", messageId: asked.id, botId: world.bot.id, threadId: world.threadId, action: "create", fingerprintVersion: 1, fingerprint: "f".repeat(64) },
  );
  now += 5 * 60_000; await routines.tick();
  now += 5 * 60_000; await routines.tick();
} else if (scenario === "venue:after-move") {
  buildVenueWorld();
  // the row is moved to posted inside the transaction; settling its card is the next call, and it never happens
  recoverAndSettleVenuePosts(db, op => transaction(op), (target, stableId) => Boolean(store.messageById(target, stableId)), () => die("venue:after-move"));
} else if (scenario === "readonly:fixture") {
  // a venue post cut short whose line is already on its target: a normal start settles it (posted + card answered); a read-only start must leave it alone
  buildVenueWorld();
  closeDatabase(); // a clean close leaves no log behind, as a normal stop does
  process.stdout.write("FIXTURE\n");
  process.exit(0);
} else if (scenario.startsWith("inspect:card:")) {
  const world = cardWorld(store, kindOf(scenario));
  const cards = world.cards().map(id => store.messageById(world.threadId, id));
  process.stdout.write(`STATE ${JSON.stringify({ unread: world.unread(), cards: cards.map(card => ({ id: card?.id, runId: card?.routineRun?.runId, status: card?.routineRun?.status })) })}\n`);
  process.exit(0);
} else if (scenario === "inspect:venue") {
  const row = heldVenuePost(db, VENUE_POST);
  const card = row?.cardMessageId ? store.messageById(row.threadId, row.cardMessageId) : undefined;
  process.stdout.write(`STATE ${JSON.stringify({ state: row?.state ?? null, answered: (card?.card as { answered?: string } | undefined)?.answered ?? null })}\n`);
  process.exit(0);
} else if (scenario.startsWith("replay:card:")) {
  // the settled run handed to the card writer once more, with the store's own writers: the card is patched and nothing is announced
  const world = cardWorld(store, kindOf(scenario));
  const run = routineStore(() => Date.now()).listRuns().find(item => item.watch?.outcome === "changed");
  const notified: string[] = [];
  if (run) writeRoutineRunCard(run, world.source, cardDeps(store, notified));
  process.stdout.write(`STATE ${JSON.stringify({ run: Boolean(run), cards: world.cards().length, unread: world.unread(), notified: notified.length })}\n`);
  process.exit(0);
}
process.stdout.write("NOT_REACHED\n");
process.exit(0);
