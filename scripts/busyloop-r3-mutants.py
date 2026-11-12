"""R3 transport mutants in a disposable offline source tree; retain assertion logs."""
import json, os, pathlib, shutil, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parent.parent
out = root / 'evidence/cfix3-busyA22/mutants'; out.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='busyloop-r3-mutants-') as temp:
    work = pathlib.Path(temp) / 'work'
    shutil.copytree(root, work, ignore=shutil.ignore_patterns('.git', 'node_modules', 'evidence', '__pycache__', 'dist', 'dist-server', 'build', '.ijfw', '.planning', 'test-results'), symlinks=True)
    (work / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
    results = []
    def run(name, tests):
        with (out / (name + '.log')).open('w') as log:
            return subprocess.run(['node_modules/.bin/vitest', 'run', *tests], cwd=work, stdout=log, stderr=subprocess.STDOUT).returncode
    witness = ['server/drivers/antigravity.test.ts', 'server/drivers/pi.test.ts', '-t', 'R3 reviewer witness']
    assert run('control-witnesses', witness) == 0
    assert run('control-sinks', ['server/drivers/busyloop-sites.test.ts', '-t', 'R3 every transport']) == 0
    def check(name, file, transform, tests):
        path = work / file; original = path.read_bytes()
        changed = transform(original.decode()); assert changed != original.decode(), name
        try:
            path.write_text(changed)
            rc = run(name, tests)
            killed = rc != 0 and 'AssertionError' in (out / (name + '.log')).read_text()
            results.append([name, 'KILLED (RED)' if killed else 'SURVIVED/INVALID'])
            print(*results[-1], flush=True)
        finally:
            path.write_bytes(original); assert path.read_bytes() == original
    for driver in ['antigravity', 'pi']:
        check('delete-route-' + driver, 'server/drivers/' + driver + '.ts',
              lambda s: 'const bypassFluxRoute = (requestUrl: any) => ({ requestUrl, routed: false });\n' + s.replace('fluxRouteFor(', 'bypassFluxRoute('),
              ['server/drivers/' + driver + '.test.ts', '-t', 'R3 reviewer witness'])
    check('new-unmarked-sink', 'server/drivers/antigravity.ts',
          lambda s: s + '\nfunction addedSink(child: import("node:child_process").ChildProcessWithoutNullStreams) { child.stdin.write(`opaque bytes`); }\n',
          ['server/drivers/busyloop-sites.test.ts', '-t', 'R3 every transport'])
    check('remove-nonmodel-marker', 'server/drivers/pi.ts',
          lambda s: s.replace('NotModelRequest("Pi get_available_models', 'unmarked("Pi get_available_models', 1),
          ['server/drivers/busyloop-sites.test.ts', '-t', 'R3 every transport'])
    (out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    assert all(r[1] == 'KILLED (RED)' for r in results), results
