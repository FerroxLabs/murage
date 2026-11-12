#!/usr/bin/env python3
"""Run isolated source mutants sequentially, restoring each file even on failure.
Run ONLY in the job's network-none test container. Reports stay in the job tree.
"""
from pathlib import Path
import subprocess, json, sys, time
out = Path('.fts-r3-evidence/mutants'); out.mkdir(parents=True, exist_ok=True)
main='server/message-search-index.ts'; worker='server/search-index-worker.ts'; tables='server/message-tables.ts'; wal='server/wal-maintenance.ts'
core='server/search-index-r3.test.ts'; bound='server/search-index-r3-bound.test.ts'; functional='server/message-search-index.test.ts'
# Each replacement changes the named safety property, not the test oracle.
mutants={
 'R1reuse':(main,[("    if (!run.resetMarker) {","    if (true) {")],'server/search-index-review-recovery.test.ts','R1: persistent'),
 'R1admission':(main,[("    assertWalWriteAdmission(run.file);","    // mutant: skipped WAL admission")],'server/search-index-review-recovery.test.ts','R1 admission'),
 'R1cap':(main,[("run.recovery.consecutive >= SEARCH_RECOVERY_CONSECUTIVE","false")],'server/search-index-review-recovery.test.ts','R1 cap'),
 'R1ready':(main,[("    run.resetMarker = undefined;","    run.recovery.consecutive = 0; run.resetMarker = undefined;")],'server/search-index-review-recovery.test.ts','R1 ready'),
 'R2worker':(worker,[("send('reset-retry');","send('stepped',{ worked: false });")],'server/search-index-review-recovery.test.ts','R2:'),
 'R2main':(main,[(" || event.type === \"reset-retry\"","")],'server/search-index-review-recovery.test.ts','R2 main'),
 'R3reader':(main,[("  } catch (error) {\n    closeReader(run); run.inflight = true;","  } catch (error) {\n    throw error;")],'server/search-index-review-recovery.test.ts','R3 reader'),
 'R3prune':(main,[("      } catch (error) { recoveryWarning(error); }","      } catch (error) { throw error; }")],'server/search-index-review-recovery.test.ts','R3 prune'),
 'R4credit':(wal,[("fullyCopied ? BigInt(h.size) : 0n","fullyCopied ? BigInt(Math.min(h.size,2147483647)) : 0n")],'server/wal-review-credit.test.ts','R4:'),
 'R5scan':(main,[("  db.prepare(\"INSERT INTO search_intents(nonce,rowid) VALUES(?,?)\").run(nonce(), rowid);","  db.prepare(\"INSERT INTO search_intents(nonce,rowid) VALUES(?,?)\").run(nonce(), rowid); db.prepare('SELECT rowid FROM messages').all();")],'server/search-index-review-bound.test.ts','T-BOUND-OWNER'),
 'R5aggregate':(main,[("  db.prepare(\"INSERT INTO search_intents(nonce,rowid) VALUES(?,?)\").run(nonce(), rowid);","  db.prepare(\"INSERT INTO search_intents(nonce,rowid) VALUES(?,?)\").run(nonce(), rowid); db.prepare('SELECT SUM(length(text)) FROM messages').get();")],'server/search-index-review-bound.test.ts','T-BOUND-OWNER'),
 'R6autorestart':(main,[("        try { startSearchIndex(db, file); } catch { /* next open retries */ }","        // mutant: unexpected worker exits never restart")],'server/memory/roster-scoped-revokes.test.ts','R6-BEHAVIORAL'),
 'R6ownerwrite':(worker,[("new DatabaseSync(file, { readOnly: true })","new DatabaseSync(file, { readOnly: false })"),("  b.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON');","  b.exec(\"PRAGMA busy_timeout=0; PRAGMA query_only=OFF; UPDATE transcript_index_state SET cursor=cursor+1 WHERE name='search_owner'\");")],'server/memory/roster-scoped-revokes.test.ts','R6-BEHAVIORAL'),
 'M1':(worker,[("new DatabaseSync(file, { readOnly: true })","new DatabaseSync(file, { readOnly: false })"),("PRAGMA query_only=ON","PRAGMA query_only=OFF")],core,'T-RO'),
 'M2':(main,[("db.prepare(\"INSERT INTO search_intents(nonce,rowid) VALUES(?,?)\").run(nonce(), rowid);","db.prepare(\"INSERT OR REPLACE INTO messages_fts_retired(rowid,t) VALUES(?,?)\").run(rowid, _text); db.prepare(\"INSERT INTO search_intents(nonce,rowid) VALUES(?,?)\").run(nonce(), rowid);")],'server/search-index-review-bound.test.ts','T-BOUND-OWNER'),
 'M3':(main,[("  db.prepare(\"INSERT INTO search_intents(nonce,rowid) VALUES(?,?)\").run(nonce(), rowid);","  db.exec(\"INSERT INTO messages_fts_retired(messages_fts_retired) VALUES('optimize')\");\n  db.prepare(\"INSERT INTO search_intents(nonce,rowid) VALUES(?,?)\").run(nonce(), rowid);")],'server/search-index-review-bound.test.ts','T-BOUND-OWNER'),
 'M4':(worker,[("  write(() => {\n    for (const item of batch.rows)","  applied(batch.rows.at(-1).intent);\n  write(() => {\n    for (const item of batch.rows)"),("    applied(batch.rows.at(-1).intent); observed(batch.seen);","    observed(batch.seen);")],core,"C5': terminating"),
 'M5':(main,[("  if (ports.fenced() || ports.deferred() > 0) return false;\n  if (!ports.admit(now - run.firstDeferredAt)) return false;","  if (!ports.admit(now - run.firstDeferredAt)) return false;\n  if (ports.fenced() || ports.deferred() > 0) return false;")],core,'T-DISPATCH'),
 'M6':(main,[("DELETE FROM search_intents WHERE seq < ?","DELETE FROM search_intents WHERE seq > ?")],core,'T-PRUNE'),
 'M7prime':('server/message-db.ts',[("${scope}${verify}${withheld}","${scope}(1 OR ${verify})${withheld}")],functional,'insert, patch'),
 'M8':(worker,[("const changed = Number(a.prepare('SELECT total_changes() AS n').get().n) - before > 1;","const changed = false;")],core,'C9'),
 'M9':(worker,[("const r = a.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();","const r = {busy:0,log:0,checkpointed:0};")],core,'C10b'),
 'M10':(worker,[("  if (String(owner()) !== state('owner')) return false;","")],core,'T-RESET-HANDSHAKE'),
 'M11':('server/memory/authority-epoch.ts',[("hard: `h${who}.${row?.hard}.${row?.pending}:${row?.version}`", "hard: `h${who}.${row?.hard}.${row?.pending}:0`")],'server/memory/roster-scoped-revokes.test.ts','T-WARM /'),
 'M12':(main,[("db.exec(`ALTER TABLE messages_fts RENAME TO ${name}`);","db.exec('DROP TABLE messages_fts');")],core,'T-RETIRE: legacy'),
 'M13':(main,[("export function stepMessageSearchBackfill(_db: DatabaseSync, _rows = 256): { more: boolean; done: number; total: number } { return { more: false, done: 0, total: 0 }; }","export function stepMessageSearchBackfill(_db: DatabaseSync, _rows = 256): { more: boolean; done: number; total: number } { _db.prepare('SELECT * FROM messages').all(); return { more: false, done: 0, total: 0 }; }")],core,'legacy fill entry points'),
 'M14':(main,[("post: () => { run.inflight = true;","post: () => { run.db.exec(\"INSERT INTO messages_fts_retired(messages_fts_retired) VALUES('optimize')\"); run.inflight = true;")],'server/search-index-review-bound.test.ts','T-BOUND-OWNER'),
 'M15':(main,[("export function settleInheritedSearchMerge(db: DatabaseSync, _firstOpen: boolean): void {","export function settleInheritedSearchMerge(db: DatabaseSync, _firstOpen: boolean): void {\n  if (db.prepare(\"SELECT 1 FROM sqlite_schema WHERE name='messages_fts'\").get()) db.exec(\"INSERT INTO messages_fts(messages_fts,rank) VALUES('merge',64)\");")],'server/search-merge-inherited.test.ts','inherited debt'),
 'M18':(main,[("VALUES('search_owner',?,0,0)\").run(randomUUID());","VALUES('search_owner',?,0,0)\").run('constant-owner');")],core,'T-RETIRE-COLLISION'),
 'M18prime':(main,[("db.prepare(\"INSERT OR REPLACE INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_owner',?,0,0)\").run(randomUUID());","if (!db.prepare(\"SELECT 1 FROM sqlite_schema WHERE name='messages_fts_retired_8'\").get()) db.prepare(\"INSERT OR REPLACE INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_owner',?,0,0)\").run(randomUUID());")],core,'T-RETIRE-COLLISION'),
 'M17':(worker,[("    const row = b.prepare('SELECT CAST(nonce AS TEXT) AS nonce FROM search_intents WHERE seq=?').get(seq);","    continue;\n    const row = b.prepare('SELECT CAST(nonce AS TEXT) AS nonce FROM search_intents WHERE seq=?').get(seq);")],core,'different nonce'),
 'M27cache':(main,[("  run.cache = null; run.indexId = null;","  run.indexId = null;")],core,'T-RESET-HANDSHAKE'),
 'M22':(tables,[("nonce INTEGER NOT NULL, rowid INTEGER, thread_key TEXT,","nonce INTEGER NOT NULL, rowid INTEGER, thread_key TEXT, text TEXT,")],core,'T-BOUND-BYTES'),
 'M23':(main,[("db.prepare(\"INSERT INTO search_intents(nonce,thread_key) VALUES(?,?)\").run(nonce(), threadKey(threadId));","db.exec(\"PRAGMA ignore_check_constraints=ON\"); db.prepare(\"INSERT INTO search_intents(nonce,thread_key) VALUES(?,?)\").run(nonce(), JSON.stringify(Array(50000).fill(1)));")],core,'T-INTENT-SIZE'),
 'M24':(wal,[("setAutocheckpoint(0)","setAutocheckpoint(1000)")],bound,'T-CKPT-DOWN'),
 'M24open':('server/database.ts',[("PRAGMA wal_autocheckpoint=0;","PRAGMA wal_autocheckpoint=1000;")],bound,'open/readiness/fallback'),
 'M36':(worker,[("for (const prefix of ['applied','seen'])","for (const prefix of ['applied'])")],core,'T-IDENTITY-REBUILD'),
 'M26prime':(main,[("SELECT seq,rowid FROM search_intents WHERE seq > ? ORDER BY seq DESC LIMIT ?","SELECT seq,rowid FROM search_intents WHERE seq > ? AND rowid IS NOT NULL ORDER BY seq DESC LIMIT ?")],core,'T-SEARCH-INTENT-CAP'),
 'M27':(main,[("      closeReader(run); run.inflight = true;", "      run.inflight = true;")],core,'T-RESET-HANDSHAKE'),
 'M20':(worker,[("WHERE seq>? ORDER BY seq LIMIT 256","WHERE seq>? ORDER BY seq DESC LIMIT 256")],core,'T-SEARCH-ORDER'),
 'M21':(main,[("DELETE FROM search_intents WHERE seq < ?","DELETE FROM search_intents WHERE seq <= ?")],core,'T-PRUNE'),
 'M25':(main,[("      reader.exec(\"COMMIT\");","      reader.exec(\"COMMIT\"); applied = Number(reader.prepare(\"SELECT v FROM search_state WHERE k='applied_seq'\").get()!.v);")],core,'T-SEARCH-SNAPSHOT'),
 'M26':(main,[("const pending = db.prepare(PENDING_SQL).all(applied, PENDING_MAX + 1);","const pending: Array<{rowid:number|null}> = [];")],core,'T-SEARCH-INTENT-CAP'),
 'M28':(worker,[("DELETE FROM search_state WHERE k='debt' AND v=?","DELETE FROM search_state WHERE k='debt' OR v=?")],core,'C11b'),
 'M29':(worker,[("busy = Number(r.busy) !== 0 || Number(r.log) !== Number(r.checkpointed);","busy = false;")],core,'C10b'),
 'M30':(main,[("      renamed = true; break;","      db.enableDefensive(false); db.exec(`DELETE FROM ${name}_config`); renamed = true; break;")],'server/search-merge-inherited.test.ts','inherited debt'),
 'M31':(main,[("if (db.prepare(\"SELECT 1 FROM sqlite_schema WHERE name=?\").get(name)) continue;","if (false) continue;")],core,'T-RETIRE-COLLISION'),
 'M32':('server/data-writers.ts',[("steps.stopSearchIndex?.() ?? true","true")],'server/search-index-r3-crash.test.ts','T-WIPE-LIVE'),
 'M33':(worker,[("    if (batch.more) put('built',batch.rows.at(-1).rowid); else del('built');","    setImmediate(() => { if (batch.more) put('built',batch.rows.at(-1).rowid); else del('built'); });")],core,"C14': rebuild rows"),
 'M34':('server/message-db.ts',[("  if (prior) syncMessageSearchRow(db(), prior.position, null);","")],functional,'T-EDIT-REPLACE'),
 'M35':(worker,[("    observed(batch.seen);\n  });\n  barrier('rebuild-after-commit');\n  return true;\n}\nfunction cleanup()", "  });\n  barrier('rebuild-after-commit');\n  return true;\n}\nfunction cleanup()")],core,'T-IDENTITY-REBUILD'),
}
selected=sys.argv[1:] or list(mutants)
results=[]
for name in selected:
 file,patches,test,pattern=mutants[name];p=Path(file);before=p.read_text();after=before
 for old,new in patches:
  if old not in after: raise RuntimeError(name+' replacement missing: '+old)
  after=after.replace(old,new)
 command=['pnpm','exec','vitest','run',test,'-t',pattern,'--maxWorkers=1']
 began=time.time()
 try:
  p.write_text(after)
  with (out/(name+'.log')).open('w') as log:
   log.write('COMMAND '+json.dumps(command)+'\n');log.flush()
   result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=150)
  report=(out/(name+'.log')).read_text()
  killed=result.returncode!=0 and 'AssertionError' in report and 'no such table' not in report and ('Unhandled Errors' not in report or name.startswith('R3'))
 except subprocess.TimeoutExpired:
  killed=False
 finally:p.write_text(before)
 row={'id':name,'killed':killed,'command':command,'seconds':round(time.time()-began,1),'log':str(out/(name+'.log'))}
 results.append(row);print(json.dumps(row),flush=True)
 (out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
if not all(row['killed'] for row in results):sys.exit(1)
