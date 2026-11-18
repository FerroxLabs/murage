#!/usr/bin/env python3
"""Execute mutation tests in an isolated copy, never patch the active server."""
from pathlib import Path
import json, os, shutil, subprocess, sys
root = Path.cwd()
out = root / os.environ.get('MUTANT_OUTPUT', 'evidence/bld-fts-amend/afix/mutants')
tree = root / 'evidence/bld-fts-amend/afix/mutant-tree'
main = 'server/message-search-index.ts'
worker = 'server/search-index-worker.ts'
rec = 'server/search-index-review-recovery.test.ts'
scrub = 'server/search-index-r3.test.ts'
turn = 'server/search-index-review-bound.test.ts'
mutants = {
 'M-EVIDENCE-EARLY-CAPTURE': ('server/memory/capture.ts', [('if (!missingIndex && (replayingEvidenceCapture.get(db) === source.id || !db.prepare(', 'if (!missingIndex) return false; if (!missingIndex && (replayingEvidenceCapture.get(db) === source.id || !db.prepare(')], turn, 'T-EVIDENCE-PENDING'),
 'M-EVIDENCE-SCAN-SORT': ('server/memory/capture.ts', [("ORDER BY json_extract(q.source,'$.threadId'), json_extract(q.source,'$.sequence'), q.source_id LIMIT 16", "LEFT JOIN messages m ON m.thread_id=json_extract(q.source,'$.threadId') AND m.id=json_extract(q.source,'$.messageId') ORDER BY json_extract(q.source,'$.threadId'), m.rowid IS NULL, COALESCE(m.seq,m.rowid), q.source_id LIMIT 16")], turn, 'T-EVIDENCE-SLICE'),
 'M-EVIDENCE-SOURCE-ORDER': ('server/memory/capture.ts', [("ORDER BY json_extract(q.source,'$.threadId'), json_extract(q.source,'$.sequence'), q.source_id LIMIT 16", "ORDER BY q.source_id LIMIT 16")], turn, 'T-EVIDENCE-ORDER'),
 'M-EVIDENCE-NOBRANCH': ('server/memory/capture.ts', [('const state = tk && branchOracle(db, tk, leaf ? Number(leaf.position) : null)(Number(message.position)) ? "active" : "retired";', 'const state = "active" as "active" | "retired";')], turn, 'T-EVIDENCE-BRANCH'),
 'M-EVIDENCE-NOCAP': ('server/memory/capture.ts', [(".all(Math.max(0, newest - EVIDENCE_FALLBACK_CAP), newest, EVIDENCE_FALLBACK_CAP)", ".all(0, newest, Number.MAX_SAFE_INTEGER)")], turn, 'T-EVIDENCE-FALLBACK'),
 'M-EVIDENCE-OPTIONAL': ('server/memory/schema.ts', [("export const EVIDENCE_VERSION = registerRequiredIndex(", "export const EVIDENCE_VERSION = registerOptionalIndex(")], turn, 'T-EVIDENCE-REQUIRED'),
 'M-EVIDENCE-NORETRY': ('server/memory/optional-index.ts', [("    if (!required && windowBuilt) return null;", "    if (required) continue; if (!required && windowBuilt) return null;")], turn, 'T-EVIDENCE-RETRY'),
 'M-AFIX-SETUP': ('server/testing/search-index-oracle.ts', [("export { expect } from 'vitest';", "import { expect as assertion } from 'vitest'; export const expect = Object.assign((v:unknown,m?:string)=>assertion(v,'ORACLE:'+((assertion.getState().currentTestName??'').match(/T-[A-Z-]+/)??[''])[0]+' '+(m??'')),assertion);")], rec, 'T-RED-SETUP'),
 'M-AFIX-FULL': (worker, [("if (storageFull(error)) { reportFull(error, message.type); }", "if (false) { reportFull(error, message.type); }")], rec, 'T-DISK-FULL'),
 'M-AFIX-ENOSPC': (worker, [("error.code === 'ENOSPC'", "false")], rec, 'T-ENOSPC'),
 'M-AFIX-WAKE': (main, [("  nudge(db);", "  /* reverted append wake */")], scrub, 'T-INTENT-NUDGE'),
 'M-AFIX-HISTORY': ('server/memory/schema.ts', [("preListen: true,\n  sql: \"CREATE INDEX IF NOT EXISTS memory_evidence_source_version", "preListen: false,\n  sql: \"CREATE INDEX IF NOT EXISTS memory_evidence_source_version")], turn, 'T-TURN-HISTORY'),
 'M-AFIX-SCAN-GATE': (turn, [("/\\bSCAN\\b/.test(detail)&&!fixedScans.has(detail)", "/\\bSCAN\\b.*\\b(?:messages|search_intents|memory_disclosures|memory_roots|memory_chunks)\\b/.test(detail)")], turn, 'T-TURN-SCAN-GATE'),
 'M-REC-NORESET': (main, [('        run.recovery.consecutive = 0;', '        /* mutant: never heal */')], rec, 'T-REC-RESET'),
 'M-REC-EARLYRESET': (main, [('    run.resetMarker = undefined;', '    run.recovery.consecutive = 0; run.resetMarker = undefined;')], rec, 'T-REC-PERSISTENT'),
 'M-REC-NOWINDOW': (main, [('run.recovery.cycleStarts.length >= SEARCH_RECOVERY_WINDOW_MAX', 'false')], rec, 'T-REC-WINDOW'),
 'M-REC-DEFERCOUNT': (main, [('    run.recovery.state = "DEFERRED";', '    run.recovery.consecutive++; run.recovery.state = "DEFERRED";')], rec, 'T-REC-DEFER'),
 'M-REC-DOUBLE': (main, [('    closeReader(run); run.inflight = true;', '    closeReader(run); run.inflight = true; run.recovery.consecutive++;')], rec, 'T-REC-ONCE'),
 'M-SCRUB-FLAT': (main, [('return Math.min(base * 2 ** Math.min(Math.max(0, n - 1), 10), cap);', 'return 10;')], scrub, 'T-SCRUB-BACKOFF'),
 'M-SCRUB-WORKED': (worker, [('worked: worked || built || cleaned.done,', 'worked: worked || built || cleaned.done || cleaned.busy,')], scrub, 'T-SCRUB-BACKOFF'),
 'M-SCRUB-STARVE': (worker, [('    const worked = apply();', '    const worked = performance.now() < scrubNotBefore ? false : apply();')], scrub, 'T-SCRUB-NOSTARVE'),
 'M-SCRUB-NORESET': (worker, [('    scrubBusy = 0; scrubNotBefore = 0;', '    /* mutant: keep previous busy count */'), ('if (debt !== scrubDebt) { scrubBusy = 0; scrubNotBefore = 0; scrubDebt = debt; }', 'if (debt !== scrubDebt) { scrubDebt = debt; }')], scrub, 'T-SCRUB-RECOVER'),
 'M-SCRUB-NOCAP': (main, [('return Math.min(base * 2 ** Math.min(Math.max(0, n - 1), 10), cap);', 'return base * 2 ** Math.max(0, n - 1);')], scrub, 'T-SCRUB-CAP'),
 'M-TURN-STATEREAD': (main, [('  db.prepare("INSERT INTO search_intents(nonce,rowid) VALUES(?,?)").run(nonce(), rowid);', '  db.prepare("INSERT INTO search_intents(nonce,rowid) VALUES(?,?)").run(nonce(), rowid); runs.get(db)?.reader?.prepare("SELECT v FROM search_state WHERE k=\'built\'").get();')], turn, 'T-TURN-OPS'),
 'M-TURN-POLL': (main, [('event.worked || run.nudged ? 10 : searchRetryDelay(event.retryInMs ?? 250)', 'event.worked ? 10 : 10')], turn, 'T-TURN-OPS'),
}
selected = sys.argv[1:] or list(mutants)
if tree.exists(): raise RuntimeError('refusing pre-existing mutant tree')
out.mkdir(parents=True, exist_ok=True)
tree.mkdir()
results = []
try:
 for item in root.iterdir():
  if item.name in {'.git', 'evidence', '.fts-r3-evidence', 'server'}: continue
  (tree / item.name).symlink_to(item, target_is_directory=item.is_dir())
 shutil.copytree(root / 'server', tree / 'server')
 (tree / 'evidence/bld-fts-amend').mkdir(parents=True)
 for name in selected:
  filename, replacements, test, pattern = mutants[name]
  path = tree / filename
  original = path.read_text()
  changed = original
  for before, after in replacements:
   if before not in changed: raise RuntimeError(f'{name}: missing mutation anchor: {before}')
   changed = changed.replace(before, after)
  path.write_text(changed)
  (out / (name + '.patch')).write_text(''.join(__import__('difflib').unified_diff(original.splitlines(True), changed.splitlines(True), fromfile=filename, tofile=filename)))
  command = ['node', 'node_modules/vitest/vitest.mjs', 'run', test, '-t', pattern, '--maxWorkers=1', '--reporter=json', '--outputFile=' + str(out / (name + '.json'))]
  try:
   with (out / (name + '.log')).open('w') as log:
    log.write('COMMAND ' + __import__('shlex').join(command) + '\n'); log.flush()
    result = subprocess.run(command, cwd=tree, stdout=log, stderr=subprocess.STDOUT, timeout=400)
   report = json.loads((out / (name + '.json')).read_text())
   failed = [row for suite in report['testResults'] for row in suite['assertionResults'] if row['status'] == 'failed']
   killed = result.returncode != 0 and bool(failed) and all(row.get('failureMessages') and row['failureMessages'][0].startswith('AssertionError') and 'ORACLE:' + pattern in row['failureMessages'][0] for row in failed)
   results.append({'mutant': name, 'command': command, 'killed': killed, 'exit': result.returncode})
   (out / os.environ.get('MUTANT_RESULTS', 'results.json')).write_text(json.dumps(results, indent=2) + '\n')
   print(name, 'KILLED' if killed else 'SURVIVED/INVALID', flush=True)
  finally: path.write_text(original)
 if not all(row['killed'] for row in results): raise SystemExit(1)
finally:
 shutil.rmtree(tree)
