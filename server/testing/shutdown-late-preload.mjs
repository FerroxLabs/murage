// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fix/1022-schema-shutdown (consumer: server/database-shutdown-seal.test.ts). Loaded into the real server with --import. It changes no
// production decision; it only makes the handover window the owner saw observable and long enough for every late timer to run in it:
//  - at SIGTERM the owner clock reads "away for an hour" (the idle passes' own gate), so the memory worker's idle pass takes its idle branch;
//  - the first close of messages.db's connection after SIGTERM (the shutdown close) is followed by the file's digest (every row of every table)
//    and, with SHUTDOWN_PROBE_DAMAGE=1, by what a newer build does to the file during a handover (an object the validator refuses);
//  - a statement on any connection to messages.db that was not used before the close (a reopen) is reported with the server/ frames that asked
//    (once per asking site, also when the reopened handle is reused by a later site);
//  - the idle pass's gate (SHUTDOWN_PROBE_SITES, "name=line" of server/index.ts) is reported when the pass reaches it after the close;
//  - the two reclaim route timers (50 ms, index.ts) run SHUTDOWN_PROBE_RECLAIM_HOLD ms later, same callback, so they fire after the close;
//  - with SHUTDOWN_PROBE_FIRE=1, every timer a server file armed for 15 minutes or more (the hourly and daily writers) fires its own callback once, 200 ms
//    after the close, as that timer would have in the window; a throw out of one is a real uncaught exception, as it would be from the timer;
//  - every worker thread a server file starts with workerData.file = messages.db is reported (`worker start before-close|after-close <frames>`) and
//    tracked until its exit (`workers-alive N` at the exit probe). SHUTDOWN_PROBE_INDEX=fail makes the FIRST index build worker fail at once (its
//    CREATE INDEX replaced by an error) and moves the retry timer it leaves (60 s, same callback) to 300 ms after the close; =slow makes the first
//    index build worker run a 60 s busy loop instead of its CREATE INDEX, so it is still running at the close (nothing of the file is written by either);
//  - SIGUSR2 opens the same window as SIGTERM without moving the clock (the restore route's close); SHUTDOWN_PROBE_ARCHIVE names the file the swap installs;
//  - in slow mode a build worker takes 2.5 s to end once terminate() is called, and SIGHUP reports the workers alive
//    at that instant (`alive-now N`): a handover that asks the thread to end and does not wait for its exit is seen;
//  - SHUTDOWN_PROBE_COUNTS=slow makes the first exact-counts worker (memory/upgrade-counts.ts, its own read-only connection to messages.db) hold an open read
//    transaction in a 60 s busy loop instead of counting (`counts-worker slow`, said by the thread once its read is done); SHUTDOWN_PROBE_PUBLISH=slow does the same for the Cloud boot-recovery
//    publisher (email/restore-job-effects.ts workerPublish, a write transaction held) (`publish-worker slow`); both take 2.5 s to end once asked;
//    SHUTDOWN_PROBE_PUBLISH=late holds the setImmediate that starts that publisher (restore-job.ts startPublish, same callback) until 300 ms after the close
//    (`publish-held`, `publish-fired`);
//  - SHUTDOWN_PROBE_LOCK="<file>,<ms>" stands in for the Cloud data-ops lock (cloud-data-ops-lock.ts, fixed at /run/murage-data-ops.lock): the open of that path opens <file>,
//    and the exclusive flock the server takes on it answers "held" for the first <ms> ms after the first time it is asked, then runs for real (so boot recovery waits and goes on "freed").
//    The one expression index.ts evaluates to decide whether this server has a data-ops lock (SHUTDOWN_PROBE_LOCK_LINE, its line) reads the Cloud role as "home";
//    nothing else sees it (a full Cloud home boot needs a secrets pipe and a supervisor; the boot recovery under test is the same code);
//  - every memory helper process the server forks (child_process.fork of memory/worker.ts: its age-index scan holds a read transaction on messages.db) is reported
//    (`helper-fork before-close|after-close <pid>`, `helper-exit`), and the restore route's SIGHUP also reports the helpers alive at that instant (`helper-alive-now N`),
//    and `helper-alive N` at the exit probe: a handover that closes the file under a live helper is seen; SHUTDOWN_PROBE_HELPER=on|stuck repeats the memory worker's boot warm
//    (the 5 s timer of worker-controller.ts start(), same callback) each second until the exit (the callback does nothing while a helper is current or the controller is stopped) ('stuck': the helper ignores its first stop: no disconnect, io-stop dropped, first SIGKILL not delivered);
//  - SIGWINCH moves the owner/worker clock ten minutes on (no other effect);
//  - process.exit waits 1.5 s once (the restore window: index.ts closeForSwap, then serving until exit), so the timers still alive run in it.
import { isMainThread } from 'node:worker_threads';
import { createRequire, syncBuiltinESMExports } from 'node:module';
if (isMainThread) {
  const { createHash } = await import('node:crypto');
  const { existsSync } = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const realNow = Date.now.bind(Date), realSetTimeout = globalThis.setTimeout;
  const sites = Object.fromEntries((process.env.SHUTDOWN_PROBE_SITES ?? '').split(',').filter(Boolean).map(entry => entry.split('=')));
  const hold = Number(process.env.SHUTDOWN_PROBE_RECLAIM_HOLD ?? 0);
  let jump = 0, termSeen = false, closed = false, exitHeld = false, probing = false;
  const helperMode = (process.env.SHUTDOWN_PROBE_HELPER ?? '') !== '', helpers = new Set(), reached = new Set(), reopened = new Set(), used = new WeakSet();
  const say = text => process.stdout.write(`SHUTDOWN-PROBE ${text}\n`);
  const serverFrames = () => { const limit = Error.stackTraceLimit; Error.stackTraceLimit = 40; try { return [...new Error().stack.matchAll(/server\/([\w./-]+\.(?:ts|mjs)):(\d+)/g)].map(m => `${m[1]}:${m[2]}`); } finally { Error.stackTraceLimit = limit; } };
  Date.now = () => {
    if (termSeen && closed && !probing) for (const frame of serverFrames()) for (const [name, line] of Object.entries(sites)) if (frame === `index.ts:${line}` && !reached.has(name)) { reached.add(name); say(`reached ${name}`); }
    return realNow() + jump;
  };
  process.on('SIGTERM', () => { termSeen = true; jump = 3_600_000; say('sigterm'); });
  // the restore handover (POST /api/restore-job/start -> closeForSwap = dataWriterGate.stop(), index.ts): no signal reaches the server, so the test arms the
  // window itself just before the request (the owner clock is not moved: the route's own work is what is under test)
  // the test asks for the live worker count at an instant of its choosing (the answer of the restore route: the swap has just been done)
  process.on('SIGHUP', () => { say(`alive-now ${alive.size}`); say(`helper-alive-now ${helpers.size}`); });
  // SIGWINCH moves the clock ten minutes on (the helper's warm pacing, worker-controller.ts nextWarmAt, has then run out: a start() in the window can fork again)
  process.on('SIGWINCH', () => { jump += 600_000; say('clock-moved'); });
  process.on('SIGUSR2', () => { termSeen = true; say('restore-armed'); });
  // the file's logical state: every row of every table (and user_version), not its bytes: the log checkpointer thread legitimately rewrites bytes after the close
  const digest = file => {
    if (!existsSync(file)) return 'absent';
    probing = true;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const hash = createHash('sha256'), json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `${item}n` : item instanceof Uint8Array ? Buffer.from(item).toString('base64') : item);
      for (const { name, sql } of db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
        hash.update(`${name}|${sql}|`);
        let rows;
        try { rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(); } catch { try { rows = db.prepare(`SELECT * FROM "${name}"`).all(); } catch { rows = 'unreadable'; } }
        hash.update(json(rows));
      }
      // the schema itself (an index built after the close changes no row)
      hash.update(json(db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all()));
      return hash.update(json(db.prepare('PRAGMA user_version').get())).digest('hex');
    } finally { db.close(); probing = false; }
  };
  const close = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function (...args) {
    let file = '';
    try { file = this.location() ?? ''; } catch { /* closed or in-memory */ }
    const result = close.apply(this, args);
    if (termSeen && !closed && file.endsWith('messages.db')) {
      closed = true;
      if (process.env.SHUTDOWN_PROBE_DAMAGE === '1') {
        probing = true; const other = new DatabaseSync(file);
        try { other.exec('CREATE TABLE gh18_operations (handover INTEGER)'); } finally { close.call(other); probing = false; }
      }
      say(`closed ${digest(file)}`);
      // the archive the restore swaps in: what the live file must still be, to the row, when the server exits
      if (process.env.SHUTDOWN_PROBE_ARCHIVE) say(`archive ${digest(process.env.SHUTDOWN_PROBE_ARCHIVE)}`);
      // a raw timer of some module this file does not name, firing in the window after the close
      const kind = process.env.SHUTDOWN_PROBE_TIMER;
      if (kind === 'database') realSetTimeout(async () => { (await import('../database.ts')).database(); }, 100);
      if (fire) {
        say(`long-timers ${longTimers.map(entry => entry.site).join(',')}`);
        longTimers.forEach((entry, at) => realSetTimeout(() => entry.callback(...entry.rest), 200 + at * 5));
      }
      if (kind === 'other-error') realSetTimeout(() => { throw new Error('PROBE_OTHER_FAULT'); }, 100);
    }
    return result;
  };
  // a statement on a connection that had not been used before the close = the file was opened again after it
  for (const method of ['prepare', 'exec']) {
    const original = DatabaseSync.prototype[method];
    DatabaseSync.prototype[method] = function (...args) {
      if (!probing && !closed) used.add(this);
      else if (!probing && !used.has(this)) {
        let file = ''; try { file = this.location() ?? ''; } catch { /* closed */ }
        const who = serverFrames().filter(frame => !/^(?:database|io-budget|testing\/[\w.-]+)(?:\.\w+)?:/.test(frame)).slice(0, 5).join('<');
        if (file.endsWith('messages.db') && !reopened.has(who)) { reopened.add(who); say(`reopen ${who}`); }
      }
      return original.apply(this, args);
    };
  }
  const longTimers = [], fire = process.env.SHUTDOWN_PROBE_FIRE === '1';
  const armedBy = () => serverFrames().find(frame => !frame.startsWith('testing/')) ?? '';
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = function (callback, delay, ...rest) {
    if (fire && delay >= 900_000 && typeof callback === 'function') longTimers.push({ callback, rest, site: armedBy() });
    return realSetInterval.call(this, callback, delay, ...rest);
  };
  const realSetImmediate = globalThis.setImmediate;
  globalThis.setImmediate = function (callback, ...rest) {
    if (publishMode === 'late' && typeof callback === 'function' && Function.prototype.toString.call(callback).includes('startPublish')) {
      say('publish-held 1');
      const poll = realSetInterval.call(globalThis, () => { if (!closed) return; clearInterval(poll); realSetTimeout(() => { say('publish-fired 1'); callback(...rest); }, 300); }, 20);
      return poll;
    }
    return realSetImmediate.call(this, callback, ...rest);
  };
  globalThis.setTimeout = function (callback, delay, ...rest) {
    if (fire && delay >= 900_000 && typeof callback === 'function') longTimers.push({ callback, rest, site: armedBy() });
    if (indexMode === 'fail' && delay === 60_000 && typeof callback === 'function' && Function.prototype.toString.call(callback).includes('attempt(left - 1')) {
      // the retry an eager index build left after its first failed attempt (optional-index.ts attempt): same callback, 300 ms after the close
      say('retry-armed');
      const poll = realSetInterval.call(globalThis, () => { if (!closed) return; clearInterval(poll); realSetTimeout(() => { say('retry-fired 1'); callback(...rest); }, 300); }, 20);
      return poll;
    }
    if (helperMode && delay === 5_000 && typeof callback === 'function' && Function.prototype.toString.call(callback).includes('warmForIntent')) {
      // the memory worker's boot warm (worker-controller.ts start(), MEMORY_BOOT_WARM_MS): same callback, repeated each second until the helper has forked, so it does not
      // depend on the owner's first action having landed before the one shot (the io budget refuses a helper start in an idle minute)
      const again = realSetInterval.call(globalThis, () => { if (exitHeld) { clearInterval(again); return; } callback(...rest); }, 1_000);
      return again;
    }
    if (hold > 0 && delay === 50 && typeof callback === 'function') {
      const source = Function.prototype.toString.call(callback);
      const name = source.includes('reclaimRootSetsWhenIdle') ? 'reclaim-roots' : source.includes('reclaimLineageSpaceInWorker') ? 'reclaim-worker' : '';
      if (name) return realSetTimeout(() => { say(`timer ${name} ${closed ? 'after-close' : 'before-close'}`); return callback(...rest); }, delay + hold);
    }
    return realSetTimeout.call(this, callback, delay, ...rest);
  };
  // worker threads that open messages.db by its file name (index builds, identity recompute, space hand-back, deferred inbox fill): not seen by the
  // DatabaseSync hooks above (another realm), so the thread's start and exit are what is observed
  const threads = createRequire(import.meta.url)('node:worker_threads'), RealWorker = threads.Worker, indexMode = process.env.SHUTDOWN_PROBE_INDEX ?? '';
  const countsMode = process.env.SHUTDOWN_PROBE_COUNTS ?? '', publishMode = process.env.SHUTDOWN_PROBE_PUBLISH ?? '';
  let countsWorkers = 0, publishWorkers = 0, publishGate = null, listened = false;
  if (publishMode === 'slow') {
    const netModule = createRequire(import.meta.url)('node:net'), realListen = netModule.Server.prototype.listen;
    netModule.Server.prototype.listen = function (...args) {
      this.once('listening', () => { if (this.address()?.port !== Number(process.env.MURAGE_PORT)) return; listened = true; if (publishGate) { Atomics.store(publishGate, 0, 1); Atomics.notify(publishGate, 0); } });
      return realListen.apply(this, args);
    };
  }
  const alive = new Set(); let indexWorkers = 0;
  const cpModule = createRequire(import.meta.url)('node:child_process'), realFork = cpModule.fork;
  cpModule.fork = function (modulePath, ...rest) {
    const child = realFork.call(this, modulePath, ...rest);
    if (/memory[\\/]worker\.(?:ts|js)$/.test(String(modulePath))) {
      if (process.env.SHUTDOWN_PROBE_HELPER === 'stuck') {
        // a helper that does not answer the first stop: it is not disconnected, io-stop is not delivered and the first SIGKILL does not land (stop() lets it go after its grace)
        const realKillOf = child.kill.bind(child), realSend = child.send.bind(child); let skipped = false;
        child.kill = signal => { if (!skipped) { skipped = true; say('helper-kill-skipped'); return true; } return realKillOf(signal); };
        child.disconnect = () => {};
        child.send = (message, ...rest) => message?.type === 'io-stop' ? true : realSend(message, ...rest);
      }
      helpers.add(child); say(`helper-fork ${closed ? 'after-close' : 'before-close'} ${child.pid}`);
      child.once('exit', () => { helpers.delete(child); say('helper-exit'); });
    }
    return child;
  };
  threads.Worker = class extends RealWorker {
    // slow mode: the thread takes 2.5 s to end once asked (a thread inside a native SQLite statement does), so only a shutdown that WAITS for the exit is seen to
    terminate() { return this.slowEnd ? new Promise(resolve => realSetTimeout(() => resolve(super.terminate()), 2500)) : super.terminate(); }
    constructor(source, options) {
      const file = options?.workerData?.file ?? options?.workerData?.dbPath, sql = options?.workerData?.sql;
      const onMessages = typeof file === 'string' && file.endsWith('messages.db');
      let given = options, slowed = '';
      if (onMessages && countsMode === 'slow' && typeof options?.workerData?.cacheFile === 'string' && countsWorkers++ === 0) {
        // the counting thread inside its read transaction (the one the count holds open across its queries) when the server closes
        source = source.replace('const result = countAtRevision(db, null, cached);', 'db.exec("BEGIN"); db.prepare("SELECT count(*) FROM messages").get(); require("node:worker_threads").parentPort.postMessage("probe-in-txn"); const until = Date.now() + 60000; while (Date.now() < until) {} const result = { fresh: false, counts: { messages: 0, conversations: 0, memoryRecords: 0, receipts: 0, firstMessageAt: null } };');
        slowed = 'counts';
      }
      if (onMessages && publishMode === 'slow' && typeof options?.workerData?.jobId === 'string' && publishWorkers++ === 0) {
        // the boot-recovery publisher inside its write transaction when the server closes
        // the thread waits for the server to listen before it takes the write lock: the boot steps before listen write messages.db themselves and, behind a lock held 60 s, die on the 1 s busy timeout (a boot crash is not the state under test)
        publishGate = new Int32Array(new SharedArrayBuffer(4)); if (listened) publishGate[0] = 1; given = { ...options, workerData: { ...options.workerData, probeGate: publishGate.buffer } };
        source = "const { DatabaseSync } = require('node:sqlite'); const { workerData } = require('node:worker_threads'); Atomics.wait(new Int32Array(workerData.probeGate), 0, 0, 120000); const db = new DatabaseSync(workerData.dbPath); db.exec('BEGIN IMMEDIATE'); require('node:worker_threads').parentPort.postMessage('probe-in-txn'); const until = Date.now() + 60000; while (Date.now() < until) {}";
        slowed = 'publish';
      }
      if (onMessages && indexMode && typeof sql === 'string' && /CREATE (UNIQUE )?INDEX/.test(sql) && indexWorkers++ === 0) {
        if (indexMode === 'fail') given = { ...options, workerData: { ...options.workerData, sql: 'SELECT no_such_probe_function()' } };
        else source = source.replace('db.exec(workerData.sql);', 'const until = Date.now() + 60000; while (Date.now() < until) {}'); // a build still running at the close (JS loop: terminate() reaches it)
        say(`index-worker ${indexMode}`);
      }
      super(source, given);
      this.slowEnd = onMessages && (slowed !== '' || indexMode === 'slow');
      // the thread says so itself once its transaction is open (the read after BEGIN, or the successful BEGIN IMMEDIATE): a replaced source that missed its target never says it
      if (slowed) this.on('message', message => { if (message === 'probe-in-txn') say(`${slowed}-worker slow`); });
      if (onMessages) {
        say(`worker ${closed ? 'after-close' : 'before-close'} ${serverFrames().filter(frame => !frame.startsWith('testing/')).slice(0, 4).join('<')}`);
        alive.add(this); this.once('exit', () => alive.delete(this));
      }
    }
  };
  if (process.env.SHUTDOWN_PROBE_LOCK) {
    const [lockFile, busyMs] = process.env.SHUTDOWN_PROBE_LOCK.split(','), busyFor = Number(busyMs); let busyUntil = 0;
    const cp = createRequire(import.meta.url)('node:child_process'), fsModule = createRequire(import.meta.url)('node:fs');
    const realSpawnSync = cp.spawnSync, realOpenSync = fsModule.openSync;
    cp.spawnSync = function (command, args, ...rest) {
      if (typeof command === 'string' && command.endsWith('/flock') && Array.isArray(args) && args.includes('-x') && (busyUntil ||= realNow() + busyFor) > realNow()) return { status: 1, signal: null, error: undefined, output: [], pid: 0, stdout: null, stderr: null };
      return realSpawnSync.call(this, command, args, ...rest);
    };
    const lockLine = process.env.SHUTDOWN_PROBE_LOCK_LINE;
    process.env = new Proxy(process.env, { get: (target, key, receiver) => key === 'MURAGE_CLOUD_ROLE' && serverFrames().includes(`index.ts:${lockLine}`) ? 'home' : Reflect.get(target, key, receiver) });
    fsModule.openSync = function (path, ...rest) { return realOpenSync.call(this, path === '/run/murage-data-ops.lock' ? lockFile : path, ...rest); };
  }
  syncBuiltinESMExports();
  const exit = process.exit;
  process.exit = function (code) {
    if (!termSeen || exitHeld) return exit.call(process, code);
    exitHeld = true;
    say('exit-held');
    realSetTimeout(() => { say(`workers-alive ${alive.size}`); say(`helper-alive ${helpers.size}`); say(`exit ${digest(process.env.SHUTDOWN_PROBE_DB ?? '')}`); exit.call(process, code); }, 1_500);
  };
}
