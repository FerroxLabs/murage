"""Run the Murage-applicable A2.1 mutants against the directly loaded TSV.
Each test command must be RED, then the production source is restored byte-for-byte.
Run only in the isolated test container.
"""
import json, os, pathlib, subprocess, sys
root = pathlib.Path(__file__).resolve().parent.parent
path = root / 'shared/flux-busyloop.ts'
original = path.read_text()
out = root / 'evidence/busyloop-a21/mutants'; out.mkdir(parents=True, exist_ok=True)
mutants = {
 'swap_text_transient': [('terminalStatus, finalCode, terminalText, hold, transient,', 'terminalStatus, finalCode, hold, transient, terminalText,')],
 'drop_403': [('new Set([401, 402, 403])', 'new Set([401, 402])')],
 'wrong_key_rejected_mark': [("d.reason === 'keyRevoked'", "d.reason.startsWith('key')")],
 'fuigo_first_code_only': [('const listed = Array.isArray(u.codes) ? u.codes : [];', 'const listed: unknown[] = [];')],
 'resubmit_transient_open': [("if (kind === 'refresh_resubmit') { this.state = 'TERMINAL'; return; }", "if (kind === 'refresh_resubmit' && isTerminal(result)) { this.state = 'TERMINAL'; return; }")],
 'no_refresh_exception': [("return refreshable && status === 401", "return false && refreshable && status === 401")],
 'refresh_on_403': [("refreshable && status === 401", "refreshable && (status === 401 || status === 403)")],
 'two_refreshes': [("if (kind === 'refresh_resubmit') { this.state = 'TERMINAL'; return; }", "if (kind === 'refresh_resubmit') { this.state = refreshEligible(status, result, this.refreshable) ? 'AUTH_REFRESH' : 'TERMINAL'; return; }"), ('this.refreshes < 1', 'this.refreshes < 2')],
 'hash_invariant': [('    this.dispatches++;', "    const seen = ((this as any)._keys ??= new Set()); if (this.state === 'TERMINAL' && !seen.has(_key)) { this.dispatches++; seen.add(_key); return; } seen.add(_key); this.dispatches++;")],
 'side_exempt': [("if (this.state === 'TERMINAL') { this.afterTerminal++;", "if (this.state === 'TERMINAL' && kind !== 'side') { this.afterTerminal++;")],
 'drop_401': [('new Set([401, 402, 403])', 'new Set([402, 403])')],
 'credit_unresolved_retry': [('const FLUX_FINAL = new Set(FINAL_ORDER.map(([code]) => code));', 'const FLUX_FINAL = new Set(FINAL_ORDER.map(([code]) => code).filter(c => c !== "credit_unresolved"));\nTRANSIENT_CODES.add("credit_unresolved");')],
 'drop_known_wait': [('transient, knownWait, unknown429', 'transient, unknown429')],
 'drop_pause': [('knownWait, unknown429, serverError', 'knownWait, serverError')],
 'drop_terminal_text': [('finalCode, terminalText, hold', 'finalCode, hold')],
 'drop_mislabel': [("s.endpoint === 'chat' && s.codes.includes('free_tier_exhausted') && !s.holdHeader", 'false')],
 'mislabel_ignores_header': [(" && !s.holdHeader", '')],
 'transient_names_stop': [('const FINAL_ORDER: ReadonlyArray<readonly [string, Reason]> = [', 'const FINAL_ORDER: ReadonlyArray<readonly [string, Reason]> = [["concurrency", "hold"], ["batch_concurrency", "busy"], '), ('new Set(FINAL_ORDER.map(([code]) => code))', 'new Set(FINAL_ORDER.map(([code]) => code).filter(c => c !== "concurrency" && c !== "batch_concurrency"))')],
 'bool_is_int': [("typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 7200 ? v", "(typeof v === 'number' && Number.isInteger(v) || typeof v === 'boolean') && Number(v) >= 0 && Number(v) <= 7200 ? Number(v)")],
 'ignore_limit': [('if (s.limit && Object.hasOwn(LIMIT_SUBTYPE, s.limit))', 'if (false && s.limit && Object.hasOwn(LIMIT_SUBTYPE, s.limit))')],
 'upstream_drops_limit': [('limit: slug(u.limit)', 'limit: undefined')],
}
# Table reorder mutants, using the exact same precedence changes as busyloop_check.py.
line = next(l for l in original.splitlines() if l.startswith('const TEXT_RULES:'))
table = json.loads(line.split(' = ', 1)[1][:-1]); kb = next(t for t in table if t[1] == 'keyBudget'); table.remove(kb); table.insert(next(i for i,t in enumerate(table) if t[1] == 'botBudget'), kb)
mutants['drop_d12'] = [(line, line.split(' = ', 1)[0] + ' = ' + json.dumps(table) + ';')]
override = next(l for l in original.splitlines() if l.startswith('const OVERRIDE_TEXT:'))
overrides = json.loads(override.split(' = ',1)[1][:-1]); table = json.loads(line.split(' = ',1)[1][:-1])
mutants['override_after_codes'] = [(override, 'const OVERRIDE_TEXT: readonly TextRule[] = [];'), (line, line.split(' = ',1)[0] + ' = ' + json.dumps(overrides+table) + ';')]
results = []
try:
 for name, replacements in mutants.items():
    selected = os.environ.get('BUSYLOOP_MUTANTS')
    if selected and name not in selected.split(','): continue
    changed = original
    for old,new in replacements:
        assert old in changed, (name, old)
        changed = changed.replace(old,new,1)
    path.write_text(changed)
    test = 'server/busyloop-parity.test.ts'
    with (out / (name + '.log')).open('w') as log:
        run = subprocess.run(['node_modules/.bin/vitest','run',test], cwd=root, stdout=log, stderr=subprocess.STDOUT)
    contents = (out / (name + '.log')).read_text()
    killed = run.returncode != 0 and 'AssertionError' in contents
    results.append((name, 'KILLED (RED)' if killed else 'SURVIVED/INVALID'))
    print(*results[-1], flush=True)
finally:
 path.write_text(original)
(out / 'results.json').write_text(json.dumps(results, indent=2)+'\n')
sys.exit(0 if all(r == 'KILLED (RED)' for _,r in results) else 1)
