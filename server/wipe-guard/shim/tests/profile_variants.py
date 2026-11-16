#!/usr/bin/env python3
"""Isolate timing costs on temporary copies; not an acceptance substitute."""
import sys
sys.dont_write_bytecode = True
import json
from pathlib import Path
import shlex
import shutil
import statistics
import subprocess
import time
from test_shim import ShimTest, SHIM

ShimTest.setUpClass()
fixture = ShimTest()
fixture.setUp()
try:
    fixture.data['realTools']['rm'] = '/bin/rm'
    fixture.save(roots=[str(fixture.home), *[str(fixture.tree / f'protected-{i}') for i in range(32)]])
    original = (SHIM / 'guard-lib.sh').read_bytes().decode()
    variations = {'original': original}
    a = original.index('wg_read_guard() {')
    b = original.index('\n}\n', a) + 3
    variations['without-read'] = original[:a] + 'wg_read_guard() { wg_guard_text=' + shlex.quote(fixture.guard.read_text()) + '; }\n' + original[b:]
    a = original.index('wg_fast_guard() {')
    b = original.index('\n}\n', a) + 3
    variations['without-parse'] = original[:a] + 'wg_fast_guard() { wg_real=/bin/rm; wg_fast=1; wg_fast_roots=1; wg_root_text=\'[]\'; }\n' + original[b:]
    a = original.index('    case $wg_header in', a)
    b = original.index('    wg_json=', a)
    variations['simple-schema-shape'] = original[:a] + '    wg_off=0\n' + original[b:]
    a = original.index('wg_root_member() {')
    b = original.index('\n}\n', a) + 3
    variations['without-membership'] = original[:a] + 'wg_root_member() { return 1; }\n' + original[b:]
    for name, source in variations.items():
        directory = fixture.tree / name
        shutil.copytree(SHIM, directory, symlinks=True)
        (directory / 'guard-lib.sh').write_bytes(source.encode())
        differences = []
        for i in range(51):
            timings = {}
            for label, command in [('real', ['/bin/dash', '-c', 'exec /bin/rm "$@"', 'rm', '-rf', str(fixture.work / 'missing')]),
                                   ('shim', ['/bin/dash', str(directory / 'rm'), '-rf', str(fixture.work / 'missing')])]:
                started = time.perf_counter_ns()
                result = subprocess.run(command, cwd=fixture.work, env=fixture.env, capture_output=True)
                assert result.returncode == 0, result.stderr
                timings[label] = time.perf_counter_ns() - started
            if i >= 10:
                differences.append((timings['shim'] - timings['real']) / 1e6)
        print('VARIANT ' + name + ' median_ms=' + str(round(statistics.median(differences), 3)), flush=True)
finally:
    fixture.doCleanups()
