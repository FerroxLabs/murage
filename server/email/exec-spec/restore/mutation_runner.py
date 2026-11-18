"""Run source mutants in a private model copy inside the integration test container."""
import json, os, shutil, subprocess, tempfile
from pathlib import Path

def run_mutants(mutations, tests, selected):
    source = Path(__file__).resolve().parent
    root = source.parents[3]
    evidence = root / '.test-tmp/restore-mutants'
    evidence.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix='restore-mutants-', dir=source.parent))
    try:
        shutil.copytree(source, scratch, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', 'invariants.cm-schema.ts'))
        def run(label):
            report = evidence / (label + '.json')
            cmd = ['node', 'node_modules/vitest/vitest.mjs', 'run', *[str((scratch / t).relative_to(root)) for t in tests], '--reporter=json', '--outputFile=' + str(report)]
            result = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=300)
            (evidence / (label + '.log')).write_text(result.stdout + result.stderr)
            data = json.loads(report.read_text())
            if not data['numTotalTests'] or any(f['status'] == 'failed' and not any(a['status'] == 'failed' for a in f['assertionResults']) for f in data['testResults']):
                raise RuntimeError(label + ': test collection failed')
            return result.returncode, data['numFailedTests']
        baseline = run('base-' + tests[0])
        if baseline != (0, 0):
            raise RuntimeError('unmutated tests failed: ' + str(baseline))
        for name in selected:
            file, old, new = mutations[name]
            target = scratch / file
            original = target.read_text()
            count = original.count(old)
            if count != 1:
                raise RuntimeError(name + ': anchor count ' + str(count))
            try:
                target.write_text(original.replace(old, new))
                code, failures = run(name)
            finally:
                target.write_text(original)
            print(name, 'RED' if code and failures else 'SURVIVED', 'failed=' + str(failures), flush=True)
            if not code or not failures:
                raise RuntimeError(name + ': survived')
        print('baseline green; all', len(selected), 'mutants killed', flush=True)
    finally:
        shutil.rmtree(scratch)
