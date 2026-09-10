import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
globalThis.__watchClock = Number(process.env.MURAGE_WATCH_CLOCK);
globalThis.__watchNotifications = [];
globalThis.fetch = async () => { throw new Error("Watch fixture forbids external requests"); };
let controls;
globalThis.__watchReady = value => { controls = value; process.send?.({ fixture: "ready", ...value.identity() }); };
process.on("message", async message => {
  if (!message || message.fixture !== "control" || !controls) return;
  try {
    if (message.now !== undefined) globalThis.__watchClock = message.now;
    if (message.tick) await controls.tick();
    process.send?.({ fixture: "reply", id: message.id, routines: controls.routines(), notifications: globalThis.__watchNotifications.length });
  } catch (error) { process.send?.({ fixture: "reply", id: message.id, error: error.message }); }
});
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith("/server/routines.ts")) {
    const source = readFileSync(new URL(url), "utf8"), anchor = "this.now = options.now ?? Date.now;";
    if (!source.includes(anchor)) throw new Error("Watch clock fixture anchor changed");
    return { format: "module-typescript", shortCircuit: true, source: source.replace(anchor, "this.now = () => globalThis.__watchClock;") };
  }
  if (url.endsWith("/server/index.ts")) {
    let source = readFileSync(new URL(url), "utf8");
    const notification = 'if (selected) broadcast({ kind: "notify", notification: selected });';
    if (!source.includes(notification)) throw new Error("Watch notification fixture anchor changed");
    source = source.replace(notification, 'if (selected) { globalThis.__watchNotifications.push(selected); broadcast({ kind: "notify", notification: selected }); }');
    return { format: "module-typescript", shortCircuit: true, source: source + `
let fixtureChief = store.bots.find(bot => bot.name === "Watch fixture Chief");
if (!fixtureChief) {
  fixtureChief = store.createBot({ name: "Watch fixture Chief", modelSelection: { instanceId: "fuigo", model: "fixture" } }, { seedMessages: false });
  store.patchBot(fixtureChief.id, { chiefOfStaff: true, chiefScope: "workspace" });
}
let fixtureWorker = store.bots.find(bot => bot.name === "Watch fixture worker");
if (!fixtureWorker) {
  fixtureWorker = store.createBot({ name: "Watch fixture worker", modelSelection: { instanceId: "fuigo", model: "fixture" } }, { seedMessages: false });
  store.patchBot(fixtureWorker.id, { cwd: process.env.MURAGE_WATCH_FOLDER });
}
beginInternalTurn(fixtureChief.id, fixtureChief.threadId, "watch-fixture-chief", 0, false);
beginInternalTurn(fixtureWorker.id, fixtureWorker.threadId, "watch-fixture-worker", 0, false);
globalThis.__watchReady({ identity: () => ({ chiefId: fixtureChief.id, chiefThread: fixtureChief.threadId, workerId: fixtureWorker.id, workerThread: fixtureWorker.threadId,
  chiefToken: internalToken(fixtureChief.id, fixtureChief.threadId, "watch-fixture-chief", "agents"),
  workerToken: internalToken(fixtureWorker.id, fixtureWorker.threadId, "watch-fixture-worker", "agents") }),
  tick: () => routines.tick(), routines: () => routines.listRoutines() });
` };
  }
  return nextLoad(url, context);
} });
