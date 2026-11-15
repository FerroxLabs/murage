#!/usr/bin/env python3
"""Optional isolated timing diagnostic; no application or real delete targets."""
import sys
sys.dont_write_bytecode = True
import json
from pathlib import Path
import statistics
import subprocess
import time
from test_shim import ShimTest, SHELLS, SHIM

ShimTest.setUpClass()
fixture = ShimTest()
fixture.setUp()
try:
    fixture.data['realTools']['rm'] = '/bin/rm'
    missing = str(fixture.work / 'missing')
    for name, shell in SHELLS.items():
        row = {}
        direct = [*shell, '-c', 'exec /bin/rm "$@"', 'rm', '-f', missing]
        for mode in ['missing-guard', 'off', 'plain', 'recursive']:
            fixture.save(off=mode == 'off')
            env = dict(fixture.env)
            if mode == 'missing-guard':
                env.pop('MURAGE_WIPE_GUARD')
            shim = [*shell, str(SHIM / 'rm'), '-rf' if mode == 'recursive' else '-f', missing]
            differences = []
            for _ in range(31):
                start = time.perf_counter_ns()
                result = subprocess.run(direct, cwd=fixture.work, env=env, capture_output=True)
                baseline = time.perf_counter_ns() - start
                start = time.perf_counter_ns()
                result = subprocess.run(shim, cwd=fixture.work, env=env, capture_output=True)
                assert result.returncode == 0, result.stderr
                differences.append((time.perf_counter_ns() - start - baseline) / 1e6)
            row[mode] = round(statistics.median(differences), 3)
        print('PROFILE ' + name + ' ' + json.dumps(row), flush=True)
finally:
    fixture.doCleanups()
