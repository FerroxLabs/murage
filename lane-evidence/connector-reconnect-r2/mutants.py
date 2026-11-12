from pathlib import Path
import subprocess, json, difflib, hashlib
E = Path('lane-evidence/connector-reconnect-r2')
source = {name: Path(name).read_text() for name in ['server/composio.ts', 'server/connected-app-health.ts']}
mutants = [
 ('status-mapping', 'server/composio.ts', 'service.accounts.filter(a => !/^ACTIVE$/i.test(a.status))', 'service.accounts.filter(() => false)', 'R2 status'),
 ('swallow-auth', 'server/composio.ts', 'if (broker && response.ok) await observeAppAnswer(cfg, payload, bytes, options.noRetry === true);', '/* mutant: discard tool failure health observation */', 'R2 broker JSON-RPC|Flux contract: tool error'),
 ('skip-preflight', 'server/composio.ts', 'if (options.scheduled) {', 'if (false) {', 'R2 scheduled preflight|R2 preflight catches'),
 ('flux-key-confusion', 'server/connected-app-health.ts', "if (brokerAuth || /Connected-apps provider rejected FluxRouter['’]s credentials/i.test(text))", 'if (false)', 'Flux contract: an in-band project-key'),
 ('skip-error-refresh', 'server/composio.ts', 'await connectedInventory(cfg, { force: true, fresh: true });', 'void cfg;', 'Flux contract: tool error|Flux contract: generic error'),
 ('ignore-active-auth', 'server/composio.ts', '.filter(([, code]) => code === 401 || (probe && code === 403))', '.filter(() => false)', 'Flux contract: preflight upstream'),
 ('generic-as-auth', 'server/connected-app-health.ts', 'if (status) reading.authStatus.set(slug, Number(status));', 'reading.authStatus.set(slug, Number(status ?? 401));', 'Flux contract: generic error'),
]
summary = []
try:
 for name, path, old, new, test in mutants:
  original = source[path]
  assert original.count(old) == 1, (name, original.count(old))
  changed = original.replace(old, new, 1)
  (E / f'mutant-{name}.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), changed.splitlines(True), fromfile=path, tofile=path)))
  Path(path).write_text(changed)
  command = ['node_modules/.bin/vitest', 'run', 'server/connector-reconnect-r2.test.ts', '-t', test]
  (E / f'mutant-{name}-command.json').write_text(json.dumps(command, indent=2))
  try:
   result = subprocess.run(command, capture_output=True, text=True, timeout=120)
   log = result.stdout + result.stderr
   (E / f'mutant-{name}.log').write_text(log)
   killed = result.returncode != 0 and 'AssertionError' in log
   summary.append({'mutant': name, 'exit': result.returncode, 'killed_at_assertion': killed})
  finally:
   Path(path).write_text(original)
 (E / 'mutants.json').write_text(json.dumps(summary, indent=2))
 (E / 'mutant-source-sha256.json').write_text(json.dumps({p: hashlib.sha256(s.encode()).hexdigest() for p, s in source.items()}, indent=2))
 print(json.dumps(summary, indent=2))
 assert all(row['killed_at_assertion'] for row in summary)
finally:
 for path, original in source.items(): Path(path).write_text(original)
