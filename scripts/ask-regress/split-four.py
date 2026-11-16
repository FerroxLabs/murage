"""Control only the shard-4 Python supervisor; its BASE Vitest child keeps running.

Run inside the already-owned baseline container through docker exec. HEAD runs
the same complete shard independently. Preserve BASE before resuming the old
supervisor; a precreated HEAD fixture prevents its redundant second leg before
any HEAD test starts. Both canonical phase receipts are genuine Vitest reports.
"""
import datetime, json, os, pathlib, shutil, signal, time

supervisor, child = 7, 214
proc = pathlib.Path('/proc')
assert b'full-shard.py\x004' in (proc / str(supervisor) / 'cmdline').read_bytes()
assert b'vitest' in (proc / str(child) / 'cmdline').read_bytes()
assert b'base-4.json' in (proc / str(child) / 'cmdline').read_bytes()
out = pathlib.Path('/tmp/ask-full-output-4')
publish = pathlib.Path('/work/evidence/ask-regress/raw/full')
publish.mkdir(parents=True, exist_ok=True)
utc = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
journal = {'supervisorPid': supervisor, 'baseVitestPid': child,
           'supervisorStoppedAt': utc(), 'testProcessesSignalled': [],
           'baseSource': '49f91a80733d03aba0c3b7a422283ee05703c911',
           'headSource': '89d58386be49d7602de75e5b9e247fc00bb8feb6',
           'headMode': 'Complete independent HEAD shard; prevent only the duplicate planned leg.'}
journal_path = publish / 'shard-4-split.json'
os.kill(supervisor, signal.SIGSTOP)
try:
    journal_path.write_text(json.dumps(journal, indent=2) + '\n')
    print(json.dumps(journal), flush=True)
    while True:
        stat = (proc / str(child) / 'stat').read_text()
        if stat.rsplit(') ', 1)[1].split()[0] == 'Z':
            break
        time.sleep(10)
    report = json.loads((out / 'base-4.json').read_text())
    inventory = json.loads((out / 'base-4.inventory.json').read_text())
    relative = lambda path: path.split('/ask-full-base-4/')[-1]
    expected = {relative(row['file']) for row in inventory}
    actual = {relative(row['name']) for row in report['testResults']}
    assert actual == expected and len(actual) == 565
    assert sum(len(row['assertionResults']) for row in report['testResults']) == report['numTotalTests']
    for artifact in out.iterdir():
        shutil.copy2(artifact, publish / artifact.name)
    # The original supervisor will write its actual subprocess return code here
    # after wait() returns; the volume survives its immediate --rm teardown.
    receipt = out / 'base-4.exit.json'
    assert not os.path.lexists(receipt)
    receipt.symlink_to(publish / receipt.name)
    duplicate_root = pathlib.Path('/tmp/ask-full-head-4')
    duplicate_root.mkdir()
    journal.update({'baseObservedDoneAt': utc(), 'baseFilesReported': len(actual),
                    'baseAssertionsReported': report['numTotalTests'],
                    'baseChildFinalProcStat': stat.strip(),
                    'supervisorResumeAt': utc(),
                    'handoff': 'All BASE files retained. Original supervisor records BASE exit then stops at existing HEAD root, before any duplicate HEAD test.'})
    journal_path.write_text(json.dumps(journal, indent=2) + '\n')
    print(json.dumps(journal), flush=True)
except BaseException:
    os.kill(supervisor, signal.SIGCONT)
    raise
os.kill(supervisor, signal.SIGCONT)
