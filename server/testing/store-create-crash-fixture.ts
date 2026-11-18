// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const [mode, stage] = process.argv.slice(2), root = process.env.MURAGE_DATA_DIR!;
const fdPaths = new Map<number, string>();
let lastRename = "", rosterWrites = 0, rollingBack = false;
const hit = (point: string) => {
  if ((mode.endsWith("crash")) && (mode.endsWith("recover-crash") ? `recovery:${point}` : rollingBack ? `rollback:${point}` : point) === stage) {
    fs.writeSync(1, `CREATE_CRASH ${stage}\n`);
    process.kill(process.pid, "SIGKILL");
  }
};
const kind = (path: string) => path.includes(".bot-create-") ? "journal" : path.includes("bots.json.") ? "roster" : path.includes("groups.json.") ? "groups" : path.endsWith(".jsonl") ? "receipt" : "other";
const writeSync = fs.writeSync;
fs.writeSync = ((fd: number, data: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
  if (mode === "receipt-recover-crash" && stage === "recovery:receipt:write" && kind(fdPaths.get(fd) ?? "") === "receipt") {
    writeSync(fd, Buffer.from(data as Uint8Array).subarray(0, 13)); hit("receipt:write");
  }
  return Reflect.apply(writeSync, fs, [fd, data, ...args]);
}) as typeof writeSync;
const open = fs.openSync, write = fs.writeFileSync, sync = fs.fsyncSync, close = fs.closeSync, rename = fs.renameSync, unlink = fs.unlinkSync;
fs.openSync = ((...args: Parameters<typeof open>) => {
  const fd = open(...args), path = String(args[0]); fdPaths.set(fd, path);
  if (args[1] === "w" || (mode === "receipt-recover-crash" && args[1] === "a")) hit(`${kind(path)}:open`);
  return fd;
}) as typeof open;
fs.writeFileSync = ((...args: Parameters<typeof write>) => {
  const path = typeof args[0] === "number" ? fdPaths.get(args[0]) ?? "" : String(args[0]);
  if ((mode === "crash" || mode === "recover-crash") && stage === `${mode === "recover-crash" ? "recovery:" : rollingBack ? "rollback:" : ""}${kind(path)}:write`) {
    write(args[0], Buffer.from(args[1] as string).subarray(0, 13)); hit(`${kind(path)}:write`);
  }
  return write(...args);
}) as typeof write;
fs.fsyncSync = fd => { sync(fd); const path = fdPaths.get(fd) ?? ""; hit(path === root ? `${lastRename}:dirsync` : `${kind(path)}:fsync`); };
fs.closeSync = fd => { const path = fdPaths.get(fd) ?? ""; close(fd); hit(`${kind(path)}:close`); };
fs.renameSync = (from, to) => {
  rename(from, to); lastRename = kind(String(from));
  if (lastRename === "roster" && ++rosterWrites === 2) hit("second-roster:rename");
  hit(`${lastRename}:rename`);
};
fs.unlinkSync = path => { unlink(path); if (String(path).includes("bot-task-state")) hit("checkpoint:cleanup"); if (String(path).includes(".bot-create-")) hit("journal:cleanup"); };
syncBuiltinESMExports();

const { Store } = await import("../store.ts");
const { closeDatabase, database, transaction } = await import("../database.ts");
const { flushCoalesced } = await import("../atomic.ts");
const { readBotRecords } = await import("../bot-turn-state.ts");
const selection = () => ({ instanceId: "fixture", model: "model" });
if (mode.startsWith("receipt-")) {
  const { RoutineManager } = await import("../routines.ts");
  const { RoutineRunsJournal } = await import("../routine-runs-journal.ts");
  const { runEventAction, eventActionId } = await import("../event-limit.ts");
  const { afterCommit } = await import("../tx-scope.ts");
  const { murageLine } = await import("../murage-line.ts");
  const options = { file: join(root, "routines.json"), botState: () => "busy" as const,
    createTask: () => ({ threadId: "unused" }), startTurn: async () => {} };
  if (mode === "receipt-recover-crash") {
    const append = RoutineRunsJournal.prototype.append;
    RoutineRunsJournal.prototype.append = function(input) { const result = append.call(this, input); hit("receipt:append"); return result; };
  }
  const manager = new RoutineManager(options);
  let store = new Store(selection);
  if (mode === "receipt-setup") {
    const bot = store.createBot({ name: "Existing" }, { seedMessages: false });
    manager.enqueueWebhook({ webhookId: "fixture-hook", webhookName: "Fixture", botId: bot.id,
      prompt: "Fixture", runOn: "ember", deliveryId: "fixture-delivery", receivedAt: 1 });
    store = new Store(selection);
  }
  const eventId = manager.findWebhookDelivery("fixture-hook", "fixture-delivery")!.id;
  const identity = ["create", "Studio", "reviewed"], actionId = eventActionId("create", identity);
  if (mode === "receipt-crash") {
    const append = RoutineRunsJournal.prototype.append;
    RoutineRunsJournal.prototype.append = function(input) {
      const result = append.call(this, input);
      if (input.runs.some(run => (run as { eventBudget?: { admissions: Array<{ receipt?: string }> } }).eventBudget?.admissions.some(a => a.receipt?.startsWith("bot:")))) hit("receipt:append");
      return result;
    };
    const db = database(), exec = db.exec.bind(db);
    db.exec = sql => { if (sql === "COMMIT") hit("sqlite:before-commit"); const result = exec(sql); if (sql === "COMMIT") hit("sqlite:after-commit"); return result; };
    const existing = store.bots[0]!;
    await runEventAction({ routines: manager, bus: { store, broadcast: () => {} }, eventId, kind: "create", identity,
      from: existing, fromThreadId: existing.threadId, fullAccess: () => false, stillActive: () => {}, revalidate: () => undefined,
      replay: () => undefined, orphan: "reuse" }, async ({ charge, record }) => {
      await charge();
      store.createBot({ name: "Reviewed" }, { seedMessages: false, staged: { rev: 1, at: 1, generation: "fixture-generation",
        byThreadId: existing.threadId, byBotId: existing.id, reason: "outside", intended: { autoApprove: false, fullAccess: false, noLimits: false, lead: false }, heldWork: [] },
        beforeCreate: id => {
          store.appendMessage(store.bot(id)!.threadId, murageLine({ role: "bot", kind: "text", text: "Fixture review notice" }));
          afterCommit(() => fs.writeSync(1, "CREATE_PUBLICATION\n"));
          record(`bot:${id}`);
        } });
    });
    throw new Error(`crash point not reached: ${stage}`);
  }
  fs.writeSync(1, "RECEIPT_SNAPSHOT " + JSON.stringify({ names: store.bots.map(bot => bot.name),
    bytes: fs.readFileSync(join(root, "bots.json")).toString("base64"),
    admission: manager.eventAdmissionExists(eventId, actionId), receipt: manager.eventAdmissionReceipt(eventId, actionId) ?? null,
    messages: database().prepare("SELECT count(*) AS n FROM messages").get()!.n,
    leftovers: fs.readdirSync(root).filter(name => name.endsWith(".tmp") || name.startsWith(".bot-create-")),
  }) + "\n");
  manager.stop(); closeDatabase(); process.exit(0);
}
if (mode === "setup") {
  new Store(selection).createBot({ name: "Existing" }, { seedMessages: false });
  const store = new Store(selection), bot = store.bots[0]!;
  store.createGroup("Existing room", [bot.id]);
  store.addTaskUsage(bot.id, bot.threadId, { input: 17, costUsd: 0.2 }, "fixture-turn");
  flushCoalesced();
  store.patchTask(bot.id, bot.threadId, { title: "Prior title" });
  if (!fs.readdirSync(join(root, "bot-task-state")).length) throw new Error("missing prior task delta");
} else if (mode === "crash") {
  const store = new Store(selection), db = database(), exec = db.exec.bind(db), prepare = db.prepare.bind(db);
  db.exec = sql => { if (sql === "COMMIT") hit("sqlite:before-commit"); const result = exec(sql); if (sql === "COMMIT") hit("sqlite:after-commit"); if (sql.startsWith("CREATE TABLE IF NOT EXISTS bot_create_commits")) hit("sqlite:marker-schema"); return result; };
  db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith("INSERT INTO bot_create_commits")) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { const result = Reflect.apply(run, statement, args); hit("sqlite:marker"); return result; };
    }
    return statement;
  };
  transaction(() => {
    for (const name of ["First new", "Second new"]) store.createBot({ name }, { staged: { rev: 1, at: 1, generation: "fixture-generation", byThreadId: "fixture-thread", byBotId: "fixture-bot", reason: "outside",
      intended: { autoApprove: false, fullAccess: false, noLimits: false, lead: false }, heldWork: [] }, beforeCreate: () => { store.patchGroup(store.groups[0]!.id, { name: "Changed room" }); } });
    if (stage.startsWith("rollback:")) { rollingBack = true; throw new Error("injected rollback"); }
  });
  throw new Error(`crash point not reached: ${stage}`);
} else if (mode !== "inspect" && mode !== "recover-crash") throw new Error("unknown fixture mode");
const store = new Store(selection);
if (mode === "setup" && !fs.readdirSync(join(root, "bot-task-state")).length) throw new Error("prior task delta was pruned during setup");
fs.writeSync(1, "CREATE_SNAPSHOT " + JSON.stringify({
  names: store.bots.map(bot => bot.name), bytes: fs.readFileSync(join(root, "bots.json")).toString("base64"),
  groups: fs.readFileSync(join(root, "groups.json")).toString("base64"),
  existing: readBotRecords(root).find(bot => bot.name === "Existing"),
  messages: database().prepare("SELECT count(*) AS n FROM messages").get()!.n,
  leftovers: fs.readdirSync(root).filter(name => name.endsWith(".tmp") || name.startsWith(".bot-create-")),
}) + "\n");
closeDatabase();
process.exit(0);
