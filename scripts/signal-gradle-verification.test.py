"""Offline D102 regression fixtures: execute the retriever and production builder."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tarfile
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RETRIEVER = ROOT / 'docs/verification/evidence/signal-gradle-d102/enrich-keys.py'
BUILDER = ROOT / 'scripts/build-signal-runtime-inputs.sh'


def put(root, name, data, executable=False):
    dest = root / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(data)
    if executable:
        dest.chmod(0o755)
    return dest


class KeyRetrieval(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='signal-key-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.job = self.root / 'job'
        self.out = self.root / 'evidence'
        self.out.mkdir()
        put(self.job, 'source/gradle/verification-metadata.xml', '''
<verification-metadata xmlns="https://schema.gradle.org/dependency-verification">
  <components><component><artifact><pgp value="0123456789ABCDEF"/>
  </artifact></component></components>
</verification-metadata>''')
        put(self.job, 'source/gradle/verification-keyring.keys', 'synthetic initial keys')
        self.log = io.StringIO()
        self.imported = []
        self.calls = []

    def run_retriever(self, responses, failure=None):
        def fake_run(args, **kwargs):
            self.calls.append(args)
            if '--import' in args and args[-1].endswith('.asc'):
                self.imported.append(type(self.root)(args[-1]).read_bytes())
                if failure == 'spawn':
                    raise OSError('synthetic process infrastructure failure')
                if failure == 'import':
                    return subprocess.CompletedProcess(args, 2, b'', b'synthetic keyring storage failure')
            if '--export' in args and failure == 'export':
                raise subprocess.CalledProcessError(2, args, stderr=b'synthetic export failure')
            return subprocess.CompletedProcess(args, 0, b'synthetic exported keys', b'')

        def redirect(value):
            return {'/job': self.job, '/evidence': self.out}.get(str(value), type(self.root)(value))

        original_write = Path.write_bytes

        def write(dest, data):
            if failure == 'write' and dest.suffix == '.asc':
                raise OSError('synthetic local write failure')
            return original_write(dest, data)

        # Map the script's production mount paths into this test's fresh fixture.
        with patch.object(Path, 'write_bytes', write), \
             patch('pathlib.Path', side_effect=redirect), \
             patch('subprocess.run', side_effect=fake_run), \
             patch('urllib.request.urlopen', side_effect=responses), \
             contextlib.redirect_stdout(self.log), contextlib.redirect_stderr(self.log):
            runpy.run_path(str(RETRIEVER), run_name='__main__')

    def test_oversized_response_is_fatal_and_never_imported(self):
        with self.assertRaisesRegex(RuntimeError, 'exceeds|oversiz'):
            self.run_retriever([io.BytesIO(b'x' * 2_000_001)])
        self.assertEqual(self.imported, [])
        self.assertFalse((self.out / 'enriched-keyring.keys').exists())

    def test_exact_limit_is_not_truncated(self):
        data = b'x' * 2_000_000
        self.run_retriever([io.BytesIO(data)])
        self.assertEqual(self.imported, [data])

    def test_network_fallback_retains_retrieval_diagnostics(self):
        self.run_retriever([
            urllib.error.HTTPError('https://example.test/key', 404, 'synthetic missing key', {}, None),
            io.BytesIO(b'synthetic key'),
        ])
        self.assertIn('404', self.log.getvalue())
        self.assertIn('keyserver.ubuntu.com', self.log.getvalue())
        self.assertIn('imported', self.log.getvalue())

    def test_unavailable_network_keeps_both_diagnostics(self):
        self.run_retriever([urllib.error.URLError('synthetic offline first'),
                            urllib.error.URLError('synthetic offline second')])
        for text in ['synthetic offline first', 'synthetic offline second', 'unavailable; SHA256 required']:
            self.assertIn(text, self.log.getvalue())
        self.assertEqual(self.imported, [])

    def test_local_write_failure_is_fatal(self):
        with self.assertRaisesRegex(OSError, 'local write failure'):
            self.run_retriever([io.BytesIO(b'synthetic key')] * 2, 'write')

    def test_local_process_failure_is_fatal(self):
        with self.assertRaisesRegex(OSError, 'process infrastructure failure'):
            self.run_retriever([io.BytesIO(b'synthetic key')] * 2, 'spawn')

    def test_import_failure_is_fatal_and_diagnostic_is_retained(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_retriever([io.BytesIO(b'synthetic key')] * 2, 'import')
        self.assertIn('synthetic keyring storage failure', self.log.getvalue())
        self.assertNotIn('unavailable; SHA256 required', self.log.getvalue())

    def test_export_failure_is_fatal(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_retriever([io.BytesIO(b'synthetic key')], 'export')


class ProductionWiring(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='signal-production-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = BUILDER.read_text()
        # Outside Docker, redirect only the container-presence probe into this
        # fixture. Inside Docker the production script executes byte-for-byte.
        if not Path('/.dockerenv').exists():
            marker = put(self.root, 'container-marker', '')
            self.assertEqual(source.count('/.dockerenv'), 1)
            source = source.replace('/.dockerenv', str(marker))
        self.script = put(self.root, 'scripts/build-signal-runtime-inputs.sh', source)
        self.pin = json.loads((ROOT / 'scripts/signal-builder.json').read_text())
        put(self.root, 'scripts/signal-builder.json', json.dumps(self.pin))
        for name in ['verification-metadata.xml', 'verification-keyring.keys']:
            put(self.root, 'gradle/' + name, (ROOT / 'gradle' / name).read_text())
        put(self.root, 'scripts/signal-reproducible.init.gradle', '// synthetic init fixture')
        put(self.root, 'server/channels/signal/evidence.mjs', "export const SIGNAL_CLI_COMMIT='synthetic-commit';")
        put(self.root, 'scripts/signal-java-inputs.py', '''import pathlib, sys
out=pathlib.Path(sys.argv[1]); out.mkdir(parents=True)
jdk=out/'jdk'; (jdk/'bin').mkdir(parents=True)
for name in ['java', 'jdeps']:
    dest=jdk/'bin'/name; dest.write_text('#!/bin/sh\\necho synthetic-java\\n'); dest.chmod(0o755)
for name in ['build-jdk', 'darwin-arm64', 'win32-x64', 'linux-x64']:
    (out/(name+'.home')).write_text(str(jdk))
''')
        # The synthetic upstream archive deliberately contains no verification inputs.
        # Its Gradle substitute observes the actual staged files and argv at execution.
        source = self.root / 'upstream'
        put(source, 'gradle/wrapper/gradle-wrapper.properties', 'distributionUrl=synthetic\n')
        put(source, 'gradlew', '''#!/usr/bin/env python3
import json, os, pathlib, sys
source=pathlib.Path.cwd(); root=source.parents[2]
(root/'gradle-started').touch()
for name in ['verification-metadata.xml', 'verification-keyring.keys']:
    staged=source/'gradle'/name
    assert staged.is_file(), 'missing staged '+name
    assert staged.read_bytes()==(root/'gradle'/name).read_bytes(), 'changed staged '+name
assert '--dependency-verification=strict' in sys.argv, 'strict verification missing'
assert '--no-configuration-cache' in sys.argv, 'configuration cache must be disabled'
assert not any(a.startswith('--write-verification-metadata') for a in sys.argv)
assert sys.argv[-1]=='installDist'
assert str(source.parent/'gradle')==os.environ['GRADLE_USER_HOME']
with (root/'observed.jsonl').open('a') as out:
    out.write(json.dumps({'source': str(source), 'argv': sys.argv[1:]})+'\\n')
(source/'build/install/signal-cli/lib').mkdir(parents=True)
''', executable=True)
        with tarfile.open(self.root / 'source.tar.gz', 'w:gz') as archive:
            archive.add(source, arcname='signal-cli-fixture')
        put(self.root, 'scripts/fetch-build-input.mjs', '''import {copyFileSync,writeFileSync} from 'node:fs';
export const BUILD_INPUTS={D060:{urls:['https://example.test/synthetic-commit']}};
if(process.argv[2]==='D060')copyFileSync(new URL('../source.tar.gz',import.meta.url),process.argv[3]);
if(process.argv[2]==='D061')writeFileSync(process.argv[3],'synthetic local Gradle ZIP');
''')
        put(self.root, 'scripts/signal-jdeps-inputs.py', '# synthetic class scanner\n')
        put(self.root, 'scripts/normalize-signal-runtime.mjs', '''import {writeFileSync} from 'node:fs';
const [,,dist,jre,target,out]=process.argv;
writeFileSync(`${out}/signal-runtime-0.14.11-48a0a5e-r1-${target}.tar.gz`,'synthetic archive');
writeFileSync(`${out}/pin-fragment-${target}.json`,'{"synthetic":true}');
''')

    def build(self):
        return subprocess.run(['bash', str(self.script), str(self.root / 'out')],
                              env={**os.environ, 'SIGNAL_BUILDER_IMAGE': self.pin['image']},
                              capture_output=True, text=True, timeout=30)

    def test_both_production_attempts_stage_exact_inputs_and_invoke_strict_gradle(self):
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        observed = [json.loads(row) for row in (self.root / 'observed.jsonl').read_text().splitlines()]
        self.assertEqual([Path(row['source']).parent.name for row in observed],
                         ['first-build', 'second-independent-build'])
        for attempt in ['first-build', 'second-independent-build']:
            sums = (self.root / 'out' / attempt / 'gradle-verification.SHA256SUMS').read_text()
            for name in ['verification-metadata.xml', 'verification-keyring.keys']:
                sha = hashlib.sha256((self.root / 'gradle' / name).read_bytes()).hexdigest()
                self.assertIn(sha + '  gradle/' + name, sums)

    def test_missing_reviewed_input_fails_before_gradle(self):
        (self.root / 'gradle/verification-keyring.keys').unlink()
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'gradle-started').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
