// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated index-harness entry ONLY. These exports/commands never enter the product bundle.
import { registerHooks } from 'node:module';
import { dirname } from 'node:path';
import { resolveWorkspaceRoot } from '../workspace-files.ts';
import { readFileSync } from 'node:fs';
import { Server } from 'node:http';
import ts from 'typescript';
import { inboxRollupBadgeAccess, InboxRoutineLifecycle, inboxRoutineRecords } from '../inbox-routine-lifecycle.ts';
import { database } from '../database.ts';
import { seedRoutineHistory, historyInside } from './routine-history-fixture.ts';
import { historyWorkProbe } from './routine-history-work.ts';
import { createSignalLocalAuthority, hasEarlierSignalAuthority } from '../channels/signal/park-authority.ts';

// Export existing lexical entrypoints and the exact channel callbacks, avoiding fake transports/credentials.
// AST extraction fails loudly if the production callbacks disappear. No copied scan can outlive its caller.
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const revokers = [];
let bindingChanged, signalOpen;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'revokeRuns') revokers.push(node.initializer.getText(ast));
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'humanBindingChanged') bindingChanged = node.initializer.getText(ast);
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'openInMurage') signalOpen = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
if (revokers.length !== 5 || !bindingChanged) throw new Error('Update history callback inventory');
const hooks = registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url === new URL('../index.ts', import.meta.url).href) return { ...result, source: source + `
export const historyStats = { lookups: 0 };
const historySource = chatSource;
chatSource = function(desktop: boolean) { const source = historySource(desktop); const lookup = source.routineOf; source.routineOf = (...args: Parameters<typeof lookup>) => { if (typeof routines?.chatRoutineOf !== "function") historyStats.lookups++; return lookup(...args); }; return source; };
export const historyFixture = { routines, store, setupRoutinesReading, legacyInboxRoutineRuns, inboxRoutineRuns, chatSource, setup, projectCloseDeps, retryOwedRoutineDeliveries, owedRoutineDeliveries, routineDeliveryDeps, signalOpen: (signal: any, signalBinding: any) => (${signalOpen}), revokers: [${revokers.join(',')}], bindingChanged: ${bindingChanged} };\n` };
  return result;
} });
const { historyFixture: app, historyStats } = await import('../index.ts');
hooks.deregister();
const manager = app.routines;
// Count the actual manager accessor, including repeated calls from one candidate.
if (typeof manager.chatRoutineOf === 'function') {
  const accessor = manager.chatRoutineOf;
  manager.chatRoutineOf = function(...args) { historyStats.lookups++; return accessor.apply(this, args); };
}
const inside = historyInside(manager);
manager.stop();
// Scale mutations have no engine work; separate real-turn test below restores the original gate.
const dispatchOpen = inside.options.dispatchOpen;
inside.options.dispatchOpen = () => false;
// Keep directly seeded pending receipts protected when owner actions emit them. This
// is a fixture output outage, not a replacement manager callback; real turn IDs use
// the original adapters, and every production delivery/lookup path still executes.
for (const key of ['owner', 'mainChat', 'isMainChat']) {
  const previous = app.routineDeliveryDeps[key];
  app.routineDeliveryDeps[key] = (run, ...args) => {
    if (run.id.startsWith('history-run-')) throw new Error('Fixture retained delivery is pending');
    return previous(run, ...args);
  };
}
const listRuns = manager.listRuns;
let rebuilds = 0, refreshes = 0, probe, startedAt = 0, elapsed = 0;
const turnStates = new Map();
const originalHistoryEmit = inside.options.emit;
let counting = false, retainedSeed = [], chatRequest = false;
manager.listRuns = function(...args) {
  if (chatRequest) rebuilds++;
  return listRuns.apply(this, args);
};
const emit = Server.prototype.emit;
Server.prototype.emit = function(event, ...args) {
  if (event !== 'request') return emit.call(this, event, ...args);
  if (!args[0].url?.startsWith('/__routine_history/')) {
    const began = performance.now();
    chatRequest = /^\/api\/(chats(?:\?|$)|search\?)/.test(args[0].url);
    args[1].once('finish', () => { elapsed = performance.now() - began; chatRequest = false; });
    return emit.call(this, event, ...args);
  }
  const [req, res] = args;
  const action = req.url.slice('/__routine_history/'.length);
  // Stop before reading/serializing control traffic; only the operation is inside the window.
  const stopped = action === 'stop' ? probe?.stop() : undefined;
  if (action === 'stop') probe = undefined;
  (async () => {
    let input = '';
    for await (const chunk of req) input += chunk;
    const data = input ? JSON.parse(input) : {};
    let result;
    if (action === 'seed') {
      inside.replaceStore([]); inside.routines = [];
      const definitions = Array.from({ length: 10 }, (_, n) => manager.create({ botId: data.botId,
        name: `History ${n}`, prompt: 'Fixture report', target: 'bot', runOn: 'ember', enabled: false,
        schedule: { type: 'interval', everyMinutes: 5, anchorAt: Date.now() + 300000 } }));
      const runs = seedRoutineHistory(manager, data.count, definitions, Date.now(), { botIds: data.botIds, groupIds: data.groupIds });
      retainedSeed = structuredClone(runs);
      app.setup.recordBriefRoutine(definitions[5].id);
      globalThis.gc?.();
      result = { definitions, sampleId: runs[5].id, now: Date.now(), retained: inside.runStore.size, chatRunThreads: new Set(runs.filter(run => run.threadId.startsWith("history-chat-")).map(run => run.threadId)).size, heapUsed: process.memoryUsage().heapUsed, forcedGC: typeof globalThis.gc === "function" };
    } else if (action === 'start') {
      // Tracked write invalidates both the owner materialization and chat cache before every operation.
      const sample = inside.indexes.runsById.get('history-run-5');
      if (data.invalidate === true) sample.output = sample.output === 'Fixture report' ? 'Fixture report changed' : 'Fixture report';
      rebuilds = 0; refreshes = 0; historyStats.lookups = 0; counting = data.counting !== false;
      if (counting) { probe = historyWorkProbe(manager); probe.install(); }
      elapsed = 0; startedAt = performance.now();
      result = { ok: true, retained: inside.runStore.size };
    } else if (action === 'stop') {
      for (const id of app.owedRoutineDeliveries) if (id.startsWith('history-run-')) app.owedRoutineDeliveries.delete(id);
      result = { work: stopped, lookupCalls: historyStats.lookups, ms: elapsed || performance.now() - startedAt, rebuilds, refreshes, retained: inside.runStore.size };
    } else if (action === 'resetHistory') {
      inside.replaceStore(structuredClone(retainedSeed));
      manager.recoverPersistence(); // Flush reset outside the window; the later single-run write is genuinely scoped.
      result = { retained: inside.runStore.size };
    } else if (action === 'writeRun') {
      if (inside.fullSave) throw new Error('Fixture single-run write requires a clean persisted baseline');
      const run = inside.indexes.runsById.get('history-run-5');
      run.output = run.output === 'Fixture report' ? 'Fixture updated' : 'Fixture report';
      inside.save({ runs: [run] });
      result = { retained: inside.runStore.size };
    } else if (action === 'refreshes') {
      result = { refreshes, retained: inside.runStore.size };
    } else if (action === 'chats') {
      // Discard unrelated index-harness boot records in this isolated fixture only.
      app.store.bots = app.store.bots.filter(bot => data.botIds.includes(bot.id));
      app.store.groups = app.store.groups.filter(group => data.groupIds.includes(group.id));
      for (const [b, id] of data.botIds.entries()) app.store.bot(id).tasks = Array.from({ length: 20 }, (_, n) => ({ threadId: `history-chat-b${b}-${n}`, title: `Fixture bot chat ${b} ${n}`, createdAt: 1700000000000 + Math.floor(n / 2), resumeCursors: {}, pinned: n === 0, unread: n % 3 === 0 }));
      for (const [g, id] of data.groupIds.entries()) app.store.group(id).tasks = Array.from({ length: 10 }, (_, n) => ({ threadId: `history-chat-g${g}-${n}`, title: `Fixture room chat ${g} ${n}`, createdAt: 1700000000000 + Math.floor(n / 2), pinned: n === 0, unread: n % 3 === 0 }));
      result = { candidates: app.store.bots.reduce((n, b) => n + b.tasks.length, 0) + app.store.groups.reduce((n, g) => n + g.tasks.length, 0) };
    } else if (action === 'operation') {
      const began = performance.now();
      const signal = createSignalLocalAuthority('', manager, () => {});
      switch (data.name) {
        case 'runNow': result = manager.runNow(data.id); break;
        case 'deleteRun': result = manager.deleteRun(data.id); break;
        case 'setRoutineBot': result = manager.update(data.id, { botId: data.botId }); break;
        case 'update': result = manager.update(data.id, { name: 'History edited' }); break;
        case 'create': result = manager.create({ botId: data.botId, name: 'History added', prompt: 'Fixture', target: 'bot', runOn: 'ember', enabled: false, schedule: { type: 'once', at: Date.now() + 300000 } }); break;
        case 'remove': result = manager.remove(data.id); break;
        case 'markAllSeen': result = manager.markAllSeen(); break;
        case 'disableForBot': result = manager.disableForBot(data.botId); break;
        case 'disableForGroup': result = manager.disableForGroup(data.groupId); break;
        case 'signalInventory': result = signal.inventory(); break;
        case 'signalVerify': result = signal.verify(['fixture-connection'], []); break;
        case 'signalEarlier': result = hasEarlierSignalAuthority(manager, 'fixture-current'); break;
        case 'channelRevoke': await app.revokers[data.channel]('fixture-connection'); result = { ok: true }; break;
        case 'bindingChanged': await app.bindingChanged('fixture-binding'); result = { ok: true }; break;
        case 'inboxLegacy': result = app.legacyInboxRoutineRuns(); break;
        case 'inboxFallback': {
          const source = { listRuns: manager.listRuns.bind(manager), inboxRunAfter: manager.inboxRunAfter.bind(manager), inboxRunOrder: manager.inboxRunOrder.bind(manager), inboxLatestRunId: manager.inboxLatestRunId.bind(manager) };
          result = inboxRoutineRecords(database(), app.store, source, app.legacyInboxRoutineRuns);
          // Repeat while the scheduled start is pending: every fallback must be counted.
          inboxRoutineRecords(database(), app.store, source, app.legacyInboxRoutineRuns);
          break;
        }
        case 'signalOpen': result = app.signalOpen({ status: () => ({ reviews: [{ deliveryId: 'fixture-delivery', state: 'needs-review', runId: 'history-run-5' }] }) }, { connectionId: 'fixture-connection' })('fixture-delivery'); break;
        case 'repairFixture': {
          const changed = [];
          for (const original of retainedSeed.slice(0, 3)) {
            let run = inside.indexes.runsById.get(original.id);
            if (!run) run = inside.appendRun({ ...original, seenAt: Date.now() });
            run.delivery = { state: 'pending' }; changed.push(run);
          }
          inside.save({ runs: changed }); result = { ok: true }; break;
        }
        case 'restoreRun': { const run = inside.appendRun(data.run); inside.save({ runs: [run] }); result = { ok: true }; break; }
        case 'cancel': result = await manager.cancelRun(data.id); break;
        case 'setup': result = app.setupRoutinesReading(); break;
        case 'projectClosePause': result = app.projectCloseDeps(app.store.group(data.groupId)).pauseRoutines(); break;
        case 'pushBadge': {
          const source = { listRuns: manager.listRuns.bind(manager) };
          result = inboxRollupBadgeAccess(database(), app.store, source, app.legacyInboxRoutineRuns).routineRuns;
          break;
        }
        case 'inboxStart': {
          const lifecycle = new InboxRoutineLifecycle(database(), app.store, manager);
          lifecycle.start(); await new Promise(resolve => setImmediate(resolve)); result = { ok: true }; break;
        }
        case 'replaceStore': inside.replaceStore(manager.listRuns()); result = { ok: true }; break;
        case 'prepareOwed': {
          app.owedRoutineDeliveries.clear();
          for (let n = 0; n < 3; n++) app.owedRoutineDeliveries.add(`history-run-${n}`);
          result = { owed: app.owedRoutineDeliveries.size }; break;
        }
        case 'owedRetry': {
          // A fixed nonempty owed backlog during an output-write outage. No delivery can
          // become unprotected and retire, so the retained N remains exact.
          const deps = app.routineDeliveryDeps, previous = { owner: deps.owner, mainChat: deps.mainChat, isMainChat: deps.isMainChat };
          const owedBefore = app.owedRoutineDeliveries.size;
          const outage = () => { throw new Error('Fixture delivery outage'); };
          Object.assign(deps, { owner: outage, mainChat: outage, isMainChat: outage });
          try { app.retryOwedRoutineDeliveries(); result = { owedBefore, owedAfter: app.owedRoutineDeliveries.size }; }
          finally { Object.assign(deps, previous); app.owedRoutineDeliveries.clear(); }
          break;
        }
        case 'recovery': {
          inside.halted = false;
          try { inside.requestRecovery(true); await new Promise(resolve => setTimeout(resolve, 1100)); }
          finally { manager.stop(); }
          result = { ok: true }; break;
        }
        case 'workspaceRoot': {
          const bot = app.store.bots[0], task = bot.tasks[0]; task.cwd = null;
          result = resolveWorkspaceRoot({ store: app.store, dataDir: dirname(inside.file), artifactScopes: () => [] }, { botId: bot.id, threadId: task.threadId }); break;
        }
        case 'startup': result = [...manager.runsForStartup()]; break;
        case 'diagnostics': result = manager.verifyIndexes(); if (result.length) throw new Error('Fixture index drift'); break;
        case 'fullSave': inside.saveFull(); result = { ok: true }; break;
        case 'fullRollback': {
          let failed = false;
          try { inside.commitMutation(() => { throw new Error('fixture rollback'); }); } catch (error) { failed = error.message === 'fixture rollback'; }
          if (!failed) throw new Error('Expected rollback'); result = { ok: true }; break;
        }
        case 'turnState': result = { statuses: turnStates.get(data.id) ?? [], present: inside.indexes.runsById.has(data.id), retained: inside.runStore.size }; break;
        case 'allowDispatch': inside.options.dispatchOpen = dispatchOpen; manager.start(); result = { ok: true }; break;
        case 'observeChats': {
          turnStates.clear();
          const previous = originalHistoryEmit;
          inside.options.emit = change => {
            previous?.(change);
            if (change.kind === 'routine.run') {
              refreshes++;
              const states = turnStates.get(change.run.id) ?? [];
              states.push(change.run.status); turnStates.set(change.run.id, states);
              // The test drains these notifications by fetching the real HTTP route.
            }
          };
          result = { ok: true }; break;
        }
        default: throw new Error('Unknown fixture operation');
      }
      // Include queued ticks and lifecycle start in their initiating operation.
      await new Promise(resolve => setImmediate(resolve));
      result ??= { ok: true };
      const end = res.end;
      res.end = function(...args) { const value = end.apply(this, args); elapsed = performance.now() - began; return value; };
    } else throw new Error('Unknown fixture control');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  })().catch(error => { probe?.stop(); probe = undefined; res.writeHead(500); res.end(JSON.stringify({ error: String(error), stack: error.stack })); });
  return true;
};
