"""Qualify one archived fix source and require real assertion kills for both review blockers."""
import hashlib, json, os, pathlib, subprocess, sys, tarfile, time

work = pathlib.Path('/work')
assert sys.argv[1:] in [[], ['mutants'], ['core']]
mutants_only = sys.argv[1:] == ['mutants']
core_only = sys.argv[1:] == ['core']
inputs = work / os.environ.get('ASK_FIX_EVIDENCE_ROOT', 'evidence/ask-regress-fix/raw')
out = inputs / ('mutants' if mutants_only else 'core' if core_only else 'qualification')
out.mkdir(parents=True, exist_ok=True)
root = pathlib.Path('/tmp/ask-fix-qualified-source')
root.mkdir()
with tarfile.open(inputs / 'head.tar.gz') as archive:
    archive.extractall(root)
    source = archive.pax_headers.get('comment')
config = root.parent / 'ask-fix-gitconfig'
config.write_text('')
env = {**os.environ, 'GIT_CONFIG_GLOBAL': str(config), 'GIT_CONFIG_SYSTEM': str(config)}
for args in [['init'], ['add', '-f', '.'], ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'Exact source fixture']]:
    subprocess.run(['git', *args], cwd=root, env=env, check=True, stdout=subprocess.DEVNULL)
os.symlink('/work/node_modules', root / 'node_modules')
records = []

def run(name, command):
    start = time.time()
    with (out / (name + '.log')).open('w') as log:
        rc = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT).returncode
    record = {'sourceCommit': source, 'name': name, 'command': command, 'exit': rc, 'seconds': time.time() - start}
    records.append(record)
    (out / 'results.json').write_text(json.dumps(records, indent=2) + '\n')
    print(json.dumps(record), flush=True)
    return rc

def vitest(name, files):
    return ['node', 'node_modules/vitest/vitest.mjs', 'run', *files, '--maxWorkers=1', '--reporter=json', '--outputFile=' + str(out / (name + '.json'))]

env['ASK_MIXED_EVIDENCE'] = str(out / 'green-workflow')
env['ASKCARDS_EVIDENCE_DIR'] = str(out / 'level-workflow')
core_files = [
    'server/askcards-mixed-batch-api.test.ts', 'scripts/ask-regress/compare.test.mjs',
    'server/askcards-budget-api.test.ts', 'server/decision/boot-wiring.test.ts',
    'server/decision/engine-action.test.ts',
    'server/permissions-preview-apply.test.ts', 'server/route-policy.test.ts',
    'server/bot-create-outside-1019.mutation.test.ts',
]
files = core_files + [
    'server/browser-owner-approve.test.ts',
    'server/browser-owner-gates.test.ts', 'server/mobile-push-risk-browser.test.ts',
    'server/respond-fresh-auth.test.ts',
]
if not mutants_only:
    if run('typecheck', ['pnpm', 'typecheck']): sys.exit(1)
    if run('green', vitest('green', core_files if core_only else files)): sys.exit(1)
else:
    if run('control', vitest('control', ['server/askcards-mixed-batch-api.test.ts', 'scripts/ask-regress/compare.test.mjs'])): sys.exit(1)

mutations = [
    ('mutant-loader-omits-real-dependency', 'server/bot-create-outside-1019.mutation.test.ts', "new Function('exports', 'require', js)(exports, loadDependency)", "new Function('exports', js)(exports)", ['server/bot-create-outside-1019.mutation.test.ts'], 46),
    ('mutant-target-ignores-new-guard', 'server/testing/botcreate-mutants.ts', '"    if (ctx.authz) return [\'refuse\', ctx.authz];\\n    if (serviceNoLimits(gen, ctx.row?.thread)) return [\'active\', null];\\n    const p = match_pass(ctx.passes!, gen, tool, action.digest);"', '"    if (ctx.authz) return [\'refuse\', ctx.authz];\\n    const p = match_pass(ctx.passes!, gen, tool, action.digest);"', ['server/bot-create-outside-1019.mutation.test.ts'], 1),
    ('permission-marker-prewrite', 'server/level-change.ts', '  delete rest.permissionExplicit;\n', '', ['server/permissions-preview-apply.test.ts'], 2),
    ('inheritance-route-unclassified', 'server/route-policy.ts', '  { methods: ["GET", "POST"], path: "/api/permissions/no-limits", class: "desktop", cloudWrite: "step-up", why: "The owner inspects or applies No limits inheritance across bots and routines; writes retain fresh owner proof." },\n', '', ['server/route-policy.test.ts'], 2),
    ('omit-batch-findings', 'server/index.ts', '{ stopHit, stopRows, tool: event.tool', '{ stopHit, tool: event.tool', ['server/askcards-mixed-batch-api.test.ts'], 4),
    ('keep-only-first-row', 'server/index.ts', '{ stopHit, stopRows, tool: event.tool', '{ stopHit, stopRows: stopRows?.slice(0, 1), tool: event.tool', ['server/askcards-mixed-batch-api.test.ts'], 4),
    ('qualification-exits-green', 'scripts/ask-regress/compare.py', "sys.exit(0 if summary['qualified'] else 1)", 'sys.exit(0)', ['scripts/ask-regress/compare.test.mjs'], 2),
    ('qualification-accepts-missing-shas', 'scripts/ask-regress/compare.py', "parser.add_argument('--base-sha', required=True)\nparser.add_argument('--head-sha', required=True)", "parser.add_argument('--base-sha')\nparser.add_argument('--head-sha')", ['scripts/ask-regress/compare.test.mjs'], 3),
    ('qualification-accepts-stale-sha', 'scripts/ask-regress/compare.py', "if requested and complete['sourceCommit'] != requested:", 'if False:', ['scripts/ask-regress/compare.test.mjs'], 1),
]
for name, file, before, after, selected, expected in mutations:
    target = root / file
    original = target.read_bytes()
    original_hash = hashlib.sha256(original).hexdigest()
    text = original.decode()
    assert text.count(before) == 1, (name, text.count(before))
    env['ASK_MIXED_EVIDENCE'] = str(out / (name + '-workflow'))
    try:
        target.write_text(text.replace(before, after, 1))
        rc = run(name, vitest(name, selected))
        report = json.loads((out / (name + '.json')).read_text())
        failures = [t for suite in report['testResults'] for t in suite['assertionResults'] if t['status'] == 'failed']
        killed = rc == 1 and len(failures) == expected and all(any('AssertionError:' in message for message in t['failureMessages']) for t in failures)
        records[-1].update(killed=killed, failedIDs=[t['fullName'] for t in failures], mutation={'file': file, 'before': before, 'after': after})
        if not killed: raise RuntimeError('Mutant was not killed by its expected assertions: ' + name)
    finally:
        target.write_bytes(original)
        restored = hashlib.sha256(target.read_bytes()).hexdigest()
        records[-1]['restoration'] = {'before': original_hash, 'after': restored, 'restored': restored == original_hash}
        (out / 'results.json').write_text(json.dumps(records, indent=2) + '\n')
        assert restored == original_hash
