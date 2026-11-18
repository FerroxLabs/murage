#!/usr/bin/env python3
"""Optional fixture-only syscall summary: no trace contains request bytes."""
import sys
sys.dont_write_bytecode = True
import subprocess
from test_shim import ShimTest, SHELLS, SHIM

ShimTest.setUpClass()
fixture = ShimTest()
fixture.setUp()
try:
    fixture.data['realTools']['rm'] = '/bin/rm'
    for roots in [1, 33]:
        fixture.save(roots=[str(fixture.home), *[str(fixture.tree / f'protected-{i}') for i in range(roots - 1)]])
        for name, shell in SHELLS.items():
            result = subprocess.run(['/tools/wg-shim/strace', '-c', '-e',
                                     'trace=read,lseek,openat,chdir,execve,clone,clone3,wait4',
                                     *shell, str(SHIM / 'rm'), '-rf', str(fixture.work / 'missing')],
                                    cwd=fixture.work, env=fixture.env, capture_output=True)
            assert result.returncode == 0, result.stderr
            print(f'SYSCALLS {name} roots={roots}\n' + result.stderr.decode(), flush=True)
finally:
    fixture.doCleanups()
