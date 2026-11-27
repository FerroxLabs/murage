// SPDX-License-Identifier: AGPL-3.0-or-later
// Self-contained worker source: production bundles do not need a .ts child entry.
// B is read-only. Materialize and RELEASE its snapshot before touching FTS on A.
export const SEARCH_INDEX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, createHash } = require('node:crypto');
const { unlinkSync, chmodSync, statSync } = require('node:fs');
const { file, searchFile, ddl, token } = workerData;
let a, b, resetWaiting = false;
const scrubDelay = eval('('+workerData.scrubDelaySource+')');
let scrubBusy = 0, scrubNotBefore = 0, scrubDebt, busyStep = 0, fullStep = 0;
const send = (type, data = {}) => parentPort.postMessage({ type, token, ...data });
const state = k => a.prepare('SELECT v FROM search_state WHERE k=?').get(k)?.v;
const put = (k,v) => a.prepare('INSERT OR REPLACE INTO search_state(k,v) VALUES(?,?)').run(k,String(v));
const del = k => a.prepare('DELETE FROM search_state WHERE k=?').run(k);
const key = id => 'h:' + createHash('sha256').update(id).digest('hex').slice(0,32);
function close() {
  if (b) { try { b.close(); } catch {} b = null; }
  if (a) { try { a.close(); } catch {} a = null; }
}
const passedBarriers = new Set();
function barrier(name) {
  if (!workerData.barrier || workerData.barrier.name !== name || passedBarriers.has(name)) return;
  passedBarriers.add(name);
  const held = new Int32Array(workerData.barrier.shared);
  send('barrier', { name });
  Atomics.store(held,0,1); Atomics.notify(held,0);
  Atomics.wait(held,0,1);
}
function readOpen() {
  b = new DatabaseSync(file, { readOnly: true });
  b.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON');
  if (workerData.readOnlyProbe) {
    let rejected = false;
    try { b.exec("UPDATE transcript_index_state SET cursor=cursor WHERE name='search_owner'"); } catch { rejected = true; }
    send('readonly-probe',{ rejected });
  }
}
function writeOpen() {
  a = new DatabaseSync(searchFile);
  try { chmodSync(searchFile,0o600); } catch {}
  if (String(a.prepare('PRAGMA journal_mode=WAL').get().journal_mode).toLowerCase() !== 'wal') throw Error('search.db requires WAL');
  a.exec('PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=0; PRAGMA journal_size_limit=0');
  a.exec(ddl);
  a.exec('CREATE TABLE IF NOT EXISTS search_state(k TEXT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS docs(rowid INTEGER PRIMARY KEY,thread_key TEXT NOT NULL,oversized INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS docs_thread ON docs(thread_key,rowid); CREATE INDEX IF NOT EXISTS docs_oversized ON docs(oversized)');
  try { chmodSync(searchFile,0o600); } catch {}
}
function latest() {
  return b.prepare('SELECT seq,CAST(nonce AS TEXT) AS nonce FROM search_intents ORDER BY seq DESC LIMIT 1').get();
}
function owner() { return b.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()?.done; }
// messages.db's schema cookie moves on every ordinary start: start-up migrations
// drop and remake triggers and indexes with no net change (owner copy: 2142 -> 2150
// in one start). A moved cookie alone used to reset and rebuild the whole index.
// Row anchors decide instead: rowid -> hash of the message's primary key, taken
// whenever the index is stamped. Every present anchor unchanged (and at least half
// present) proves the rowids the index points at still name the same messages, so
// the index adopts the new cookie. Any changed anchor, or none stored: reset.
const rowHash = r => createHash('sha256').update(JSON.stringify([String(r.thread_id),String(r.id)])).digest('hex').slice(0,16);
function anchors() {
  const top = Number(b.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM messages').get().n);
  const at = b.prepare('SELECT rowid,thread_id,id FROM messages WHERE rowid>=? ORDER BY rowid LIMIT 1');
  const rows = new Map();
  for (let i = 0; top && i < 48; i++) { const r = at.get(1 + Math.floor(top * i / 48)); if (r) rows.set(Number(r.rowid), r); }
  for (const r of b.prepare('SELECT rowid,thread_id,id FROM messages ORDER BY rowid DESC LIMIT 16').all()) rows.set(Number(r.rowid), r);
  return [...rows.values()].map(r => Number(r.rowid)+':'+rowHash(r)).join(',');
}
function anchorsHold() {
  const stored = state('source_anchors');
  if (!stored) return false;
  const one = b.prepare('SELECT thread_id,id FROM messages WHERE rowid=?');
  let present = 0, total = 0;
  for (const item of stored.split(',')) {
    const [rowid, hash] = item.split(':'); total++;
    const r = one.get(Number(rowid));
    if (!r) continue;
    if (rowHash(r) !== hash) return false;
    present++;
  }
  return present * 2 >= total;
}
function valid() {
  if (String(owner()) !== state('owner')) return false;
  const schema = String(b.prepare('PRAGMA schema_version').get().schema_version);
  const moved = schema !== state('source_schema');
  if (moved && !anchorsHold()) return false;
  for (const prefix of ['applied','seen']) {
    const seq = state(prefix+'_seq'), nonce = state(prefix+'_nonce');
    if (!seq || !nonce) return false;
    const row = b.prepare('SELECT CAST(nonce AS TEXT) AS nonce FROM search_intents WHERE seq=?').get(seq);
    if (!row || String(row.nonce) !== nonce) return false;
  }
  if (moved) { const fresh = anchors(); a.exec('BEGIN IMMEDIATE'); try { put('source_schema',schema); put('source_anchors',fresh); a.exec('COMMIT'); } catch (error) { if (a.isTransaction) a.exec('ROLLBACK'); throw error; } send('source-adopted',{ schema: Number(schema) }); }
  return true;
}
function observed(marker) { put('seen_seq',marker.seq); put('seen_nonce',marker.nonce); }
function applied(intent) { put('applied_seq',intent.seq); put('applied_nonce',intent.nonce); }
function requestReset() { close(); resetWaiting = true; send('reset-needed'); }
function snapshot(read) {
  b.exec('BEGIN');
  try {
    if (!valid()) { b.exec('ROLLBACK'); requestReset(); return null; }
    const out = read(); out.seen = latest();
    b.exec('COMMIT');
    barrier('snapshot-released');
    return out;
  } catch (error) { if (b?.isTransaction) b.exec('ROLLBACK'); throw error; }
}
// Read no more than the remaining byte budget. Oversized rows are represented in
// docs and make every search partial until edited/deleted. They never stall progress
// or cause an unrestricted TEXT/JSON fetch. SQL substr operates on byte blobs.
function live(rowid, budget) {
  const meta = b.prepare('SELECT thread_id,kind,octet_length(text) AS nt,octet_length(json) AS nj FROM messages WHERE rowid=?').get(rowid);
  if (!meta) return { rowid, live: false, bytes: 0 };
  const n = meta.kind === 'text' ? Number(meta.nt || 0) : meta.kind === 'activity' ? Number(meta.nj || 0) : 0;
  if (n > budget) return { rowid, live: true, thread: key(meta.thread_id), oversized: true, bytes: 0 };
  let text = null;
  if (n) {
    const column = meta.kind === 'text' ? 'text' : 'json';
    const value = b.prepare('SELECT substr(CAST('+column+' AS BLOB),1,?) AS value FROM messages WHERE rowid=?').get(budget,rowid).value;
    const str = Buffer.from(value).toString('utf8');
    if (meta.kind === 'text') text = str;
    else { try { const name = JSON.parse(str).tool?.name; if (typeof name === 'string') text = name; } catch {} }
  }
  return { rowid, live: true, thread: key(meta.thread_id), text, bytes: n };
}
function converge(row) {
  a.prepare('DELETE FROM messages_fts WHERE rowid=?').run(row.rowid);
  a.prepare('DELETE FROM docs WHERE rowid=?').run(row.rowid);
  if (!row.live) return;
  if (row.text) a.prepare('INSERT INTO messages_fts(rowid,t) VALUES(?,?)').run(row.rowid,row.text);
  if (row.text || row.oversized) a.prepare('INSERT INTO docs(rowid,thread_key,oversized) VALUES(?,?,?)').run(row.rowid,row.thread,row.oversized ? 1 : 0);
}
// Measured write cost of this step: bytes each commit appended to search.db-wal (a log that restarted counts from 0), and the
// same again when a checkpoint copies them into search.db. The parent spaces steps by it (a full rebuild wrote 4-11 GB/min).
let stepBytes = 0;
const walSize = () => { try { return statSync(searchFile+'-wal').size; } catch { return 0; } };
function write(run) {
  const before = walSize();
  a.exec('BEGIN IMMEDIATE');
  try { run(); barrier('before-search-commit'); a.exec('COMMIT'); barrier('after-search-commit'); }
  catch (error) { if (a.isTransaction) a.exec('ROLLBACK'); throw error; }
  const after = walSize(); stepBytes += 2 * (after >= before ? after - before : after);
}
function apply() {
  const batch = snapshot(() => {
    const intents = b.prepare('SELECT seq,CAST(nonce AS TEXT) AS nonce,rowid,thread_key FROM search_intents WHERE seq>? ORDER BY seq LIMIT 256').all(state('applied_seq'));
    const rows = []; let bytes = 0;
    for (const intent of intents) {
      if (intent.thread_key !== null) { if (!rows.length) rows.push({ intent, drop: true }); break; }
      const row = live(intent.rowid,4*1024*1024-bytes);
      // A normal row which exceeds only this batch's remaining budget waits for
      // the next batch; only a row over the absolute limit is permanently partial.
      if (row.oversized && bytes) break;
      rows.push({ intent, row }); bytes += row.bytes;
      if (bytes >= 4*1024*1024) break;
    }
    return { rows };
  });
  if (!batch) return false;
  if (!batch.rows.length) return false;
  if (batch.rows[0].drop) return drop(batch.rows[0].intent);
  write(() => {
    for (const item of batch.rows) {
      const existed = a.prepare('SELECT 1 FROM docs WHERE rowid=?').get(item.row.rowid);
      converge(item.row);
      if (existed) put('debt',item.intent.seq+':0');
    }
    barrier('apply-before-progress');
    applied(batch.rows.at(-1).intent); observed(batch.seen);
  });
  return true;
}
function drop(intent) {
  const batch = snapshot(() => {
    const ids = a.prepare('SELECT rowid FROM docs WHERE thread_key=? AND rowid>? ORDER BY rowid LIMIT 257').all(intent.thread_key,Number(state('drop_cursor') || 0));
    const rows = []; let bytes = 0;
    for (const id of ids.slice(0,256)) {
      const row = live(id.rowid,4*1024*1024-bytes);
      if (row.oversized && bytes) break;
      rows.push(row); bytes += row.bytes;
      if (bytes >= 4*1024*1024) break;
    }
    return { rows, more: ids.length > rows.length };
  });
  if (!batch) return false;
  write(() => {
    for (const row of batch.rows) converge(row);
    if (batch.more) put('drop_cursor',batch.rows.at(-1).rowid);
    else { applied(intent); del('drop_cursor'); put('debt',intent.seq+':0'); barrier('drop-last'); }
    observed(batch.seen); barrier('drop-before-progress-commit');
  });
  if (!batch.more) barrier('drop-after-commit');
  return true;
}
function rebuild() {
  if (state('built') === undefined) return false;
  const batch = snapshot(() => {
    const ids = b.prepare('SELECT rowid FROM messages WHERE rowid<? ORDER BY rowid DESC LIMIT 257').all(state('built'));
    const rows = []; let bytes = 0;
    for (const id of ids.slice(0,256)) {
      const row = live(id.rowid,4*1024*1024-bytes);
      if (row.oversized && bytes) break;
      rows.push(row); bytes += row.bytes;
      if (bytes >= 4*1024*1024) break;
    }
    return { rows, more: ids.length > rows.length };
  });
  if (!batch) return false;
  write(() => {
    for (const row of batch.rows) converge(row);
    barrier('rebuild-before-progress');
    if (batch.more) put('built',batch.rows.at(-1).rowid); else del('built');
    observed(batch.seen);
  });
  barrier('rebuild-after-commit');
  return true;
}
function cleanup() {
  const debt = state('debt');
  if (debt !== scrubDebt) { scrubBusy = 0; scrubNotBefore = 0; scrubDebt = debt; }
  if (!debt) return { done: false };
  // A rebuild commits a new segment every step, so the merge probe below never
  // reads zero while it runs, and each negative merge restarts a merge of the
  // whole index: O(index) bytes per step, about 17 GB for a 55 MB owner index.
  // The debt stays recorded and is scrubbed by the first step after the rebuild.
  if (state('built') !== undefined) return { done: false };
  if (debt.endsWith(':0')) {
    // A writing negative merge proves nothing. Continue positive slices until a
    // fresh negative probe writes zero pages (total_changes includes FTS shadows).
    const mergePages = Math.max(1,Math.min(64,Math.trunc(Number(workerData.mergePages || 64))));
    write(() => {
      const before = Number(a.prepare('SELECT total_changes() AS n').get().n);
      a.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('merge',"+(-mergePages)+")");
      const changed = Number(a.prepare('SELECT total_changes() AS n').get().n) - before > 1;
      barrier('merge-prove');
      if (!changed) a.prepare("UPDATE search_state SET v=? WHERE k='debt' AND v=?").run(debt.slice(0,-1)+'1',debt);
      else a.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('merge',"+mergePages+")");
    });
    if (state('debt') === debt.slice(0,-1)+'1') barrier('merge-after-commit');
    return { done: true };
  } else {
    const now = performance.now();
    if (now < scrubNotBefore) return { done: false, retryInMs: scrubNotBefore - now };
    let busy;
    try {
      const r = a.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      barrier('after-scrub');
      busy = Number(r.busy) !== 0 || Number(r.log) !== Number(r.checkpointed);
    } catch (error) {
      if (typeof error.errcode !== 'number' || ![5,6].includes(error.errcode & 255)) throw error;
      busy = true;
    }
    if (busy) {
      const retryInMs = scrubDelay(++scrubBusy);
      scrubNotBefore = performance.now() + retryInMs;
      send('scrub-busy',{ n: scrubBusy, retryInMs });
      return { done: false, retryInMs, busy: true };
    }
    a.prepare("DELETE FROM search_state WHERE k='debt' AND v=?").run(debt);
    scrubBusy = 0; scrubNotBefore = 0;
    return { done: true };
  }
}
function reset(marker) {
  close();
  scrubBusy = 0; scrubNotBefore = 0; scrubDebt = undefined;
  barrier('reset-before-delete');
  for (const suffix of ['-wal','-shm','']) {
    try { unlinkSync(searchFile+suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (suffix === '-wal') barrier('reset-after-wal-delete');
  }
  readOpen(); writeOpen();
  b.exec('BEGIN');
  let seen, top, who, schema, anchored;
  try {
    who = owner(); seen = latest(); schema = b.prepare('PRAGMA schema_version').get().schema_version; anchored = anchors();
    if (!b.prepare('SELECT 1 FROM search_intents WHERE seq=? AND nonce=?').get(marker.seq,marker.nonce)) throw Error('reset marker lost');
    top = b.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM messages').get().n;
    b.exec('COMMIT');
  } catch (error) { b.exec('ROLLBACK'); throw error; }
  write(() => {
    put('index_id',randomUUID()); put('owner',who); put('source_schema',schema); put('source_anchors',anchored); applied(marker); observed(seen); put('built',Number(top)+1);
  });
  resetWaiting = false; send('ready',{ index_id: state('index_id'), synchronous: Number(a.prepare('PRAGMA synchronous').get().synchronous), journal_mode: a.prepare('PRAGMA journal_mode').get().journal_mode });
}
// 1.0.22 q1022-startup: quick_check and the FTS integrity-check read all of search.db. They run only when the last writer did not
// stop cleanly (no clean_close mark: crash, kill, failure, reset) or the last full check is a week old or unreadable; the mark is
// cleared before anything else on open, so a crash after this start checks again on the next one.
const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
// The mark names the index position at the clean stop: an older build run on the same folder (a rollback to 1.0.21) never clears it, so
// one that indexed anything and then crashed leaves a mark that no longer matches, and the next start checks (self-review M4).
const cleanMark = () => state('index_id')+':'+state('applied_seq')+':'+state('applied_nonce');
function checkDue() {
  const clean = state('clean_close') === cleanMark(), last = Number(state('checked_at')), now = Date.now();
  return !clean || !(last > 0) || now < last || now - last >= CHECK_EVERY_MS;
}
function stopClean() {
  if (!a || resetWaiting) return;
  try { a.exec('BEGIN IMMEDIATE'); put('clean_close',cleanMark()); a.exec('COMMIT'); } catch { try { if (a.isTransaction) a.exec('ROLLBACK'); } catch {} }
}
function activate() {
  readOpen(); writeOpen();
  const due = checkDue();
  if (state('clean_close') !== undefined) { a.exec('BEGIN IMMEDIATE'); try { del('clean_close'); a.exec('COMMIT'); } catch (error) { if (a.isTransaction) a.exec('ROLLBACK'); throw error; } }
  if (due) {
    send('full-check');
    if (a.prepare('PRAGMA quick_check').get().quick_check !== 'ok') return requestReset();
    a.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
  }
  b.exec('BEGIN'); let ok;
  try { ok = valid(); b.exec('COMMIT'); } catch (error) { b.exec('ROLLBACK'); throw error; }
  if (!ok) return requestReset();
  if (due) { a.exec('BEGIN IMMEDIATE'); try { put('checked_at',Date.now()); a.exec('COMMIT'); } catch (error) { if (a.isTransaction) a.exec('ROLLBACK'); throw error; } }
  send('ready',{ index_id: state('index_id'), synchronous: Number(a.prepare('PRAGMA synchronous').get().synchronous), journal_mode: a.prepare('PRAGMA journal_mode').get().journal_mode });
}
parentPort.on('message', message => {
  if (message.token !== token) return;
  try {
    if (message.type === 'stop') { stopClean(); close(); parentPort.close(); return; }
    if (message.type === 'activate') { close(); activate(); return; }
    if (message.type === 'reset') { reset(message.marker); return; }
    if (message.type === 'reset-request') { if (!resetWaiting) requestReset(); return; }
    if (message.type !== 'step' || resetWaiting) return;
    const stepStart = performance.now(); stepBytes = 0;
    const worked = apply();
    if (resetWaiting) return;
    const built = rebuild();
    if (resetWaiting) return;
    const cleaned = cleanup();
    busyStep = 0; fullStep = 0;
    send('stepped',{ worked: worked || built || cleaned.done, retryInMs: cleaned.retryInMs, scrubBusy, rebuilding: state('built') !== undefined, applied: Number(state('applied_seq')), bytes: stepBytes, 'step-ms': performance.now() - stepStart });
  } catch (error) {
    if (storageFull(error)) { reportFull(error, message.type); }
    else if (typeof error.errcode === 'number' && [5,6].includes(error.errcode & 255)) {
      if (resetWaiting || message.type === 'reset') { close(); resetWaiting = true; send('reset-retry'); }
      else { const retryInMs = scrubDelay(++busyStep); send('stepped',{ worked: false, retryInMs }); }
    }
    else { send('failure',{ message: String(error.message) }); requestReset(); }
  }
});
function storageFull(error) {
  return error.code === 'ENOSPC' || error.code === 'SQLITE_FULL' || (typeof error.errcode === 'number' && (error.errcode & 255) === 13);
}
function reportFull(error, operation) {
  send('storage-full',{ message: String(error.message), operation, retryInMs: Math.min(100 * 2 ** Math.min(++fullStep,8),30000) });
}
try { activate(); } catch (error) {
  if (storageFull(error)) reportFull(error,'activate');
  else { send('failure',{ message: String(error.message) }); requestReset(); }
}
`;
