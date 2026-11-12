"""Attribute raw full-run failures; never turn diagnostic reds into a green gate."""
import collections, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tarfile, time

work = pathlib.Path('/work')
spec = json.loads((work / (sys.argv[1] if len(sys.argv) > 1 else 'evidence/ask-regress/upstream-delta-input.json')).read_text())
label = spec.get('label', 'upstream-delta')
assert re.fullmatch('[a-z0-9-]+', label)
out = pathlib.Path('/tmp') / ('ask-' + label + '-output')
out.mkdir()
common_env = dict(os.environ)
if spec.get('packageArchive'):
    package_archive = work / 'evidence/ask-regress/raw' / spec['packageArchive']
    assert hashlib.sha256(package_archive.read_bytes()).hexdigest() == spec['packageSha256']
    package_root = pathlib.Path('/tmp') / ('ask-' + label + '-package')
    package_root.mkdir()
    with tarfile.open(package_archive) as archive:
        members = archive.getmembers()
        for member in members:
            path = pathlib.PurePosixPath(member.name)
            assert not path.is_absolute() and '..' not in path.parts
            assert path.parts[0] == 'package' and (member.isfile() or member.isdir())
        archive.extractall(package_root, members=members)
    common_env['OPENCLAW_PACKAGE_DIR'] = str(package_root / 'package')
records, tests, hashes = [], {}, {}
for phase, archive_name in [('upstream', 'upstream.tar.gz'), ('head', 'head.tar.gz')]:
    root = pathlib.Path('/tmp') / ('ask-' + label + '-' + phase)
    root.mkdir()
    with tarfile.open(work / 'evidence/ask-regress/raw' / archive_name) as archive:
        archive.extractall(root)
        source = archive.pax_headers.get('comment')
    assert source == spec[phase]
    config = root.parent / ('ask-' + label + '-gitconfig-' + phase)
    config.write_text('')
    home = root.parent / ('ask-' + label + '-home-' + phase)
    home.mkdir()
    env = {**common_env, 'HOME': str(home), 'USERPROFILE': str(home),
           'OPENCLAW_PROOF_REPORT': str(out / (phase + '-openclaw-proof.json')),
           'GIT_CONFIG_GLOBAL': str(config), 'GIT_CONFIG_SYSTEM': str(config)}
    for args in [['init'], ['add', '-f', '.'], ['-c', 'user.name=ci', '-c', 'user.email=maintainer@example.invalid', 'commit', '-qm', 'Exact source fixture']]:
        subprocess.run(['git', *args], cwd=root, env=env, check=True, stdout=subprocess.DEVNULL)
    os.symlink('/work/node_modules', root / 'node_modules')
    hashes[phase] = {file: hashlib.sha256((root / file).read_bytes()).hexdigest() for file in spec['files']}
    start = time.time()
    report = out / (phase + '.json')
    command = ['node', 'node_modules/vitest/vitest.mjs', 'run', *spec['files'],
               '--maxWorkers=1', '--reporter=json', '--outputFile=' + str(report)]
    with (out / (phase + '.log')).open('w') as log:
        result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    row = {'sourceCommit': source, 'phase': phase, 'vitestExit': result.returncode,
           'seconds': time.time() - start, 'report': report.exists()}
    records.append(row)
    (out / 'runs.json').write_text(json.dumps(records, indent=2) + '\n')
    print(json.dumps(row), flush=True)
    assert result.returncode in [0, 1] and report.exists()
    data = json.loads(report.read_text())
    tests[phase] = {}
    for suite in data['testResults']:
        file = str(pathlib.Path(suite['name']).relative_to(root))
        occurrences = collections.Counter()
        for test in suite['assertionResults']:
            name = test['fullName'].replace(str(root), '<source>')
            occurrences[name] += 1
            key = f'{file} :: {name} :: {occurrences[name]}'
            tests[phase][key] = {'status': test['status'], 'failureMessages': test.get('failureMessages', [])}
targets = spec['targetIDs'] + spec.get('extraTargetIDs', [])
same = [key for key in targets if all(tests[phase].get(key, {}).get('status') == 'failed' for phase in tests)]
summary = {'meaning': 'Runtime attribution only; original full-run new failures remain failures.',
           'fullGateQualified': False, 'runs': records, 'testFileHashes': hashes,
           'sameTestBytes': hashes['upstream'] == hashes['head'],
           'targetCount': len(targets), 'fullRunTargetCount': len(spec['targetIDs']),
           'extraTargetCount': len(spec.get('extraTargetIDs', [])), 'sameFailureIDs': same,
           'differentTargets': {key: {phase: tests[phase].get(key) for phase in tests}
                                for key in targets if key not in same}}
(out / 'comparison.json').write_text(json.dumps(summary, indent=2) + '\n')
for phase in tests:
    (out / (phase + '-by-id.json')).write_text(json.dumps(tests[phase], indent=2) + '\n')
publish = work / 'evidence/ask-regress/raw' / label
publish.mkdir(parents=True, exist_ok=True)
for artifact in out.iterdir():
    shutil.copy2(artifact, publish / artifact.name)
print(json.dumps({'attributedFailureCount': len(same), 'unattributedTargetCount': len(summary['differentTargets']),
                  'fullGateQualified': False}), flush=True)
