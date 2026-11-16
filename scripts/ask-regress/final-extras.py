"""Qualify the frozen source and explicitly execute its optional offline witness."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tarfile, time

work = pathlib.Path('/work')
root = pathlib.Path('/tmp/ask-extras-source')
root.mkdir()
with tarfile.open(work / 'evidence/ask-regress/raw/head.tar.gz') as archive:
    archive.extractall(root)
    source = archive.pax_headers.get('comment')
os.symlink('/work/node_modules', root / 'node_modules')
package_archive = work / 'evidence/ask-regress/raw/package/openclaw-2026.10.5.tgz'
package_hash = hashlib.sha256(package_archive.read_bytes()).hexdigest()
assert package_hash == 'dbb1bdcf2346292e25f672822b6a9928c234909abe6fee0df5fc4556e769d40e'
package_root = pathlib.Path('/tmp/ask-extras-openclaw')
package_root.mkdir()
with tarfile.open(package_archive) as archive:
    members = archive.getmembers()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        assert not path.is_absolute() and '..' not in path.parts
        assert path.parts[0] == 'package' and (member.isfile() or member.isdir())
    archive.extractall(package_root, members=members)
out = pathlib.Path('/tmp/ask-extras-output')
out.mkdir()
env = {**os.environ, 'OPENCLAW_PACKAGE_DIR': str(package_root / 'package'),
       'OPENCLAW_PROOF_REPORT': str(out / 'openclaw-proof.json')}
records = []
for name, command in [
    ('typecheck', ['pnpm', 'typecheck']),
    ('openclaw-package', ['node', 'node_modules/vitest/vitest.mjs', 'run',
                         'server/drivers/acp/openclaw-package.test.ts', '--maxWorkers=1',
                         '--reporter=json', '--outputFile=' + str(out / 'openclaw-package.json')]),
]:
    start = time.time()
    with (out / (name + '.log')).open('w') as log:
        result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    row = {'sourceCommit': source, 'check': name, 'exit': result.returncode,
           'seconds': time.time() - start, 'packageSha256': package_hash}
    records.append(row)
    print(json.dumps(row), flush=True)
(out / 'results.json').write_text(json.dumps(records, indent=2) + '\n')
publish = work / 'evidence/ask-regress/raw/final-extras'
publish.mkdir(parents=True, exist_ok=True)
for artifact in out.iterdir():
    shutil.copy2(artifact, publish / artifact.name)
sys.exit(int(any(row['exit'] for row in records)))
