#!/usr/bin/env python3
"""Run only in the throwaway, network-disabled IT container.

WG_SHELL_ASSETS defaults to /tools/wg-shim: bash-3.2 (launcher), zsh,
busybox (static), fish (launcher). Missing shells are failures, never skips.
"""
import json
import os
from pathlib import Path
import pwd
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import unittest

SHIM = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
ASSETS = Path(os.environ.get('WG_SHELL_ASSETS', '/tools/wg-shim'))
SHELLS = {
    'dash': ['/bin/dash'],
    'bash5': ['/bin/bash', '--posix'],
    'bash3.2': [str(ASSETS / 'bash-3.2'), '--posix'],
    'zsh-sh': [str(ASSETS / 'zsh'), '--emulate', 'sh'],
    'ash': [str(ASSETS / 'busybox'), 'ash'],
}
TOOLS = ['rm', 'rmdir', 'mv', 'dd', 'shred', 'wipefs', 'mkfs', 'mkfs.ext4', 'diskutil']
TOOLS += sorted(path.name for path in SHIM.glob('mkfs.*') if path.name not in TOOLS)
COUNTS = {'checks': 0, 'witnesses': 0, 'timing': {}}


def records(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


class ShimTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not Path('/.dockerenv').exists():
            raise RuntimeError('Delete tests require the throwaway IT container')
        for shell in SHELLS.values():
            if not Path(shell[0]).is_file():
                raise RuntimeError(f'required real shell missing: {shell[0]}')
        if not (ASSETS / 'fish').is_file():
            raise RuntimeError('required fish witness missing')

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wg-shim-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.tree = Path(self.temporary.name)
        self.home = self.tree / 'home' / 'fixture'
        self.home.mkdir(parents=True)
        self.work = self.tree / 'project'
        self.work.mkdir()
        self.realbin = self.tree / 'realbin'
        self.realbin.mkdir()
        for tool in TOOLS:
            destination = self.realbin / tool
            shutil.copyfile(FIXTURES / 'real-tool.py', destination)
            destination.chmod(0o755)
        self.calls = self.tree / 'calls.jsonl'
        self.reals = self.tree / 'real.jsonl'
        self.guard = self.tree / 'guard.json'
        self.data = {
            'v': 1, 'socket': str(self.tree / 'app.sock'),
            'threadId': 'fixture-turn', 'token': 'fixture-only',
            'roots': [str(self.home)],
            'client': [sys.executable, str(FIXTURES / 'client.py')],
            'realTools': {tool: str(self.realbin / tool) for tool in TOOLS},
            'off': False,
        }
        self.save()
        self.env = dict(os.environ, PATH=f'{SHIM}:{self.realbin}:/usr/bin:/bin',
                        HOME=str(self.tree), MURAGE_WIPE_GUARD=str(self.guard),
                        WG_CALL_LOG=str(self.calls), WG_REAL_LOG=str(self.reals),
                        WG_CLIENT_EXIT='10')
        self.env.pop('MURAGE_WIPE_GUARD_OFF', None)

    def save(self, **changes):
        self.data.update(changes)
        self.guard.write_text(json.dumps(self.data, ensure_ascii=False, separators=(',', ':')))
        self.guard.chmod(0o600)

    def run_tool(self, shell, tool, args, *, match=False, env=None, status=None, shim_dir=SHIM):
        before_calls = len(records(self.calls))
        before_reals = len(records(self.reals))
        result = subprocess.run([*shell, str(shim_dir / tool), *map(str, args)],
                                env=env or self.env, cwd=self.work, capture_output=True,
                                timeout=30)
        COUNTS['checks'] += 1
        self.assertEqual(len(records(self.calls)) - before_calls, int(match), result.stderr)
        expected = (10 if match else 0) if status is None else status
        self.assertEqual(result.returncode, expected, result.stderr)
        # // MAIN RULING SEAN 1114-WIPE-HYBRID: REFINED fail direction exits 126.
        if expected not in (10, 126):
            self.assertEqual(len(records(self.reals)) - before_reals, 1, result.stderr)
            self.assertEqual(records(self.reals)[-1]['argv'], list(map(str, args)))
            self.assertEqual(records(self.reals)[-1]['cwd'], str(self.work))
            self.assertEqual(records(self.reals)[-1]['lc_all'], (env or self.env).get('LC_ALL'))
        else:
            self.assertEqual(len(records(self.reals)), before_reals)
        return result

    def test_01_shells_and_root_spelling(self):
        link = self.work / 'home-link'
        link.symlink_to(self.home, target_is_directory=True)
        for name, shell in SHELLS.items():
            for target in [self.home, str(self.home) + '///', '../home/fixture',
                           '../home/./fixture', '../home/fixture/../fixture', link,
                           'home-link/../fixture', './home-link/.']:
                with self.subTest(shell=name, target=str(target)):
                    self.run_tool(shell, 'rm', ['-frv', '--', target], match=True)
                    self.assertEqual(records(self.calls)[-1]['targets'], [str(self.home)])

    def test_02_options_and_nonrecursive_rm(self):
        file = self.home / 'ordinary file'
        file.touch()
        for name, shell in SHELLS.items():
            for args, match in [
                (['-rf', self.home], True), (['-fR', self.home], True),
                (['--recursive', self.home], True),
                (['-f', self.home], False), ([file], False), (['-f', file], False),
                (['--', '-rf', self.home], False),
                (['--recursive-looking', self.home], False),
                (['-rf', file], True),  # the only child = the entire nonempty root
                (['-rf', str(self.home) + '-suffix'], False),
                (['-rf', self.work], False),
                (['--interactive=never', '-rf', self.home], True),
            ]:
                with self.subTest(shell=name, args=list(map(str, args))):
                    self.run_tool(shell, 'rm', args, match=match)

    def test_03_nearly_all_boundaries_and_duplicates(self):
        # Ten children, including two dot children and a filename with newline.
        children = [self.home / x for x in ['.a', '..b', 'a', 'b', 'c', 'd', 'e', 'f',
                                          'space name', 'line\nname']]
        for child in children:
            child.touch()
        for name, shell in SHELLS.items():
            with self.subTest(shell=name):
                self.run_tool(shell, 'rm', ['-rf', *children[:8]], match=False)
                self.run_tool(shell, 'rm', ['-rf', *children[:9]], match=True)
                self.run_tool(shell, 'rm', ['-rf', *children], match=True)
                self.run_tool(shell, 'rm', ['-rf', *([children[0]] * 20)], match=False)
                self.run_tool(shell, 'rmdir', children[:9], match=True)
        # A deeper descendant does not count as a direct child.
        directory = self.home / 'directory'
        directory.mkdir()
        nested = directory / 'nested'
        nested.touch()
        self.run_tool(SHELLS['dash'], 'rm', ['-rf', nested], match=False)

    def test_04_small_and_empty_roots(self):
        shell = SHELLS['dash']
        self.run_tool(shell, 'rm', ['-rf', self.home / 'missing'], match=False)
        one = self.home / 'one'
        one.touch()
        self.run_tool(shell, 'rm', ['-rf', one], match=True)
        two = self.home / 'two'
        two.touch()
        self.run_tool(shell, 'rm', ['-rf', one], match=False)
        self.run_tool(shell, 'rm', ['-rf', one, two], match=True)
        for i in range(17):
            (self.home / f'extra-{i}').touch()
        selected = list(self.home.iterdir())[:17]
        self.run_tool(shell, 'rm', ['-rf', *selected], match=False)  # 17/19 < 90%
        self.run_tool(shell, 'rm', ['-rf', *list(self.home.iterdir())[:18]], match=True)

    def test_05_mv_sources_and_destinations(self):
        source = self.work / 'source'
        source.touch()
        for name, shell in SHELLS.items():
            for args, match in [
                ([source, self.home], False), ([self.home, self.work / 'dest'], True),
                (['-ft', self.work, self.home], True),
                (['-t' + str(self.work), self.home], True),
                ([self.home, '--target-directory', self.work], True),
                (['--target-directory=' + str(self.home), source], False),
                (['-S', str(self.home), source, self.work / 'dest'], False),
                (['--', self.home, self.work / 'dest'], True),
            ]:
                with self.subTest(shell=name, args=list(map(str, args))):
                    self.run_tool(shell, 'mv', args, match=match)

    def test_06_device_and_disk_tools(self):
        for name, shell in SHELLS.items():
            for tool, args, match in [
                ('dd', ['if=/dev/sda', 'of=' + str(self.work / 'image')], False),
                ('dd', ['if=/dev/zero', 'of=/dev/sda', 'bs=1M'], True),
                ('dd', ['of=/dev/null'], False), ('dd', ['of=/dev/zero'], False),
                ('shred', ['-uvz', '/dev/nvme0n1'], True),
                ('shred', ['-n', '3', self.work / 'file'], False),
                ('wipefs', ['--all', '/dev/mapper/fixture'], True),
                ('wipefs', ['--types', '/dev/sda', self.work / 'file'], False),
                ('mkfs', ['-t', 'ext4', '/dev/sda1'], True),
                ('mkfs.ext4', ['-F', '/dev/loop7'], True),
                # // MAIN RULING SEAN 1114-WIPE-HYBRID: REFINED matches any mkfs.
                ('mkfs.ext4', [self.work / 'image'], True),
                ('diskutil', ['eraseDisk', 'APFS', 'Fixture', 'disk9'], True),
                ('diskutil', ['eraseVolume', 'APFS', 'Fixture', '/Volumes/Fixture'], True),
                ('diskutil', ['secureErase', '0', 'disk9'], True),
                ('diskutil', ['apfs', 'deleteVolume', 'disk9s1'], True),
                ('diskutil', ['list'], False), ('diskutil', ['apfs', 'list'], False),
                ('diskutil', ['info', self.home], False),
            ]:
                with self.subTest(shell=name, tool=tool, args=list(map(str, args))):
                    self.run_tool(shell, tool, args, match=match)

    def test_07_output_exit_and_argument_identity(self):
        args = ['-rf', '--', 'a b', 'line\nname', 'quote\"name', "single'name",
                r'back\slash', '-r', '', 'literal*', '$(literal)', '`literal`', 'é-😀']
        for name, shell in SHELLS.items():
            with self.subTest(shell=name):
                env = dict(self.env, WG_REAL_STDOUT='tool stdout\n',
                           WG_REAL_STDERR='tool stderr\n', WG_REAL_EXIT='37')
                result = self.run_tool(shell, 'rm', args, env=env, status=37)
                self.assertEqual(result.stdout, b'tool stdout\n')
                self.assertEqual(result.stderr, b'tool stderr\n')
                self.assertEqual(records(self.reals)[-1]['argv'], args)
                env['WG_CLIENT_EXIT'] = '0'
                result = self.run_tool(shell, 'rm', ['-rf', self.home], match=True,
                                       env=env, status=37)
                self.assertEqual(result.stdout, b'tool stdout\n')
                self.assertEqual(result.stderr, b'tool stderr\n')

    def test_08_fail_directions_and_switches(self):
        # // MAIN RULING SEAN 1114-WIPE-HYBRID: REFINED requires unreachable exit 126.
        for name, shell in SHELLS.items():
            with self.subTest(shell=name):
                for code in ['1', '11', '127']:
                    result = self.run_tool(shell, 'rm', ['-rf', self.home], match=True,
                                           env=dict(self.env, WG_CLIENT_EXIT=code), status=126)
                    self.assertIn(b'app unreachable; refused ', result.stderr)
                    self.assertEqual(result.stderr.count(b'\n'), 1)
                self.run_tool(shell, 'rm', ['-rf', self.home],
                              env=dict(self.env, MURAGE_WIPE_GUARD_OFF='1'))
                self.save(off=True)
                self.run_tool(shell, 'rm', ['-rf', self.home])
                self.save(off=False)
                self.run_tool(shell, 'rm', ['-rf', self.home],
                              env=dict(self.env, MURAGE_WIPE_GUARD=str(self.tree / 'absent')))
                self.guard.write_text('{broken json')
                self.run_tool(shell, 'rm', ['-rf', self.home])
                self.save()
                self.save(client=[])
                result = self.run_tool(shell, 'rm', ['-rf', self.home], status=126)
                self.assertIn(b'app unreachable', result.stderr)
                self.save(client=[sys.executable, str(FIXTURES / 'client.py')])

    def test_09_path_fallback_and_no_recursion(self):
        self.save(realTools={})
        for shell in SHELLS.values():
            self.run_tool(shell, 'rm', ['-rf', self.work / 'ordinary'])
        alias = self.tree / 'shim-alias'
        alias.symlink_to(SHIM, target_is_directory=True)
        self.env['PATH'] = f'{alias}:{SHIM}/.:{SHIM}:{self.realbin}:/usr/bin:/bin'
        self.save(realTools={'rm': str(SHIM / 'rm')})
        for shell in SHELLS.values():
            self.run_tool(shell, 'rm', ['-rf', self.work / 'ordinary'])

    def test_10_unicode_spaces_newlines_and_json(self):
        root = self.tree / 'root space\nquote"\\é-😀'
        root.mkdir()
        self.save(roots=[str(root)])
        # Both JSON.stringify-style literal UTF-8 and escaped Unicode JSON.
        for ascii_only in [False, True]:
            self.guard.write_text(json.dumps(self.data, ensure_ascii=ascii_only, indent=2))
            for name, shell in SHELLS.items():
                with self.subTest(shell=name, ascii=ascii_only):
                    self.run_tool(shell, 'rm', ['-rf', '--', root], match=True)
                    request = records(self.calls)[-1]
                    self.assertEqual(request['argv'], ['-rf', '--', str(root)])
                    self.assertEqual(request['targets'], [str(root)])

    def test_11_windows_drive_forms(self):
        self.save(roots=['C:\\Users\\Fixture'])
        for shell in SHELLS.values():
            for path in ['/c/Users/Fixture', 'C:\\Users\\Fixture',
                         'C:/Users/Fixture/', 'C:\\Users/Fixture\\.',
                         '/c/Users/Other/../Fixture']:
                self.run_tool(shell, 'rm', ['-rf', path], match=True)
                self.assertEqual(records(self.calls)[-1]['targets'], ['/c/Users/Fixture'])
            self.run_tool(shell, 'rm', ['-rf', '/c/Users/Fixture2'], match=False)

    def test_12_very_long_argv(self):
        args = ['-rf', '--', *[f'missing-{i:05}-with space' for i in range(4000)]]
        for name, shell in SHELLS.items():
            with self.subTest(shell=name):
                self.run_tool(shell, 'rm', args)

    def test_13_runtime_witnesses_end_in_real_rm(self):
        # The stub client denies; root survives. Each final real exec is then
        # repeated with allow, and only this container's fake root is deleted.
        self.data['realTools']['rm'] = '/bin/rm'
        self.save()
        quoted = shlex.quote(str(self.home))
        witnesses = {
            'nounset-parent-env-child': (
                SHELLS['bash5'], f'set -u; export TARGET={quoted}; /bin/sh -uc \'rm -rf "$TARGET"\''),
            'loop': (SHELLS['bash5'], f'for p in {quoted}; do rm -rf "$p"; done'),
            'list': (SHELLS['bash5'], f'set -- {quoted}; for p; do rm -rf "$p"; done'),
            'child-dash': (SHELLS['dash'], f'/bin/sh -c {shlex.quote("rm -rf " + quoted)}'),
            'child-bash': (SHELLS['bash5'], f'/bin/bash -c {shlex.quote("rm -rf " + quoted)}'),
            'child-zsh': (SHELLS['zsh-sh'], f'{shlex.quote(str(ASSETS / "zsh"))} --emulate sh -c {shlex.quote("rm -rf " + quoted)}'),
            'su-command': (SHELLS['dash'],
                f'su --preserve-environment --shell=/bin/sh --command={shlex.quote("rm -rf " + quoted)} {shlex.quote(pwd.getpwuid(os.getuid()).pw_name)}'),
            'python-uc': (SHELLS['dash'],
                f'{shlex.quote(sys.executable)} -uc ' + shlex.quote(
                    'import os; os.execvp("rm", ["rm", "-rf", ' + repr(str(self.home)) + '])')),
            'fish-command': (SHELLS['dash'],
                f'{shlex.quote(str(ASSETS / "fish"))} --no-config --command={shlex.quote("rm -rf " + quoted)}'),
            'expanded-glob': (SHELLS['bash5'], f'rm -rf {quoted}/*'),
        }
        for name, (shell, command) in witnesses.items():
            for allow in [False, True]:
                self.home.mkdir(exist_ok=True)
                (self.home / 'one').write_text('fixture')
                (self.home / 'two').write_text('fixture')
                before = len(records(self.calls))
                result = subprocess.run([*shell, '-c', command], cwd=self.work,
                                        env=dict(self.env, WG_CLIENT_EXIT='0' if allow else '10'),
                                        capture_output=True, timeout=20)
                with self.subTest(witness=name, allow=allow):
                    self.assertEqual(result.returncode, 0 if allow else 10, result.stderr)
                    self.assertEqual(len(records(self.calls)), before + 1, result.stderr)
                    self.assertEqual((self.home / 'one').exists(), not allow)
                    self.assertEqual((self.home / 'two').exists(), not allow)
                    if not allow:
                        COUNTS['witnesses'] += 1

    def test_14_benign_runtime_lookalikes(self):
        quoted = shlex.quote(str(self.home))
        for shell in SHELLS.values():
            commands = [f'printf "%s\\n" "rm -rf {self.home}"',
                        f'TARGET={quoted}; printf "%s\\n" "$TARGET"',
                        f'rm -f -- {quoted}/ordinary-file',
                        'for p in harmless-a harmless-b; do rm -rf "$p"; done']
            for command in commands:
                before = len(records(self.calls))
                result = subprocess.run([*shell, '-c', command], cwd=self.work, env=self.env,
                                        capture_output=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(records(self.calls)), before)

    def test_14b_symlink_children_and_diagnostic_lines(self):
        link = self.home / 'link\nchild'
        link.symlink_to(self.work, target_is_directory=True)
        child = self.home / 'second'
        child.touch()
        for shell in SHELLS.values():
            self.run_tool(shell, 'rm', ['-rf', link, child], match=True)
        root = self.tree / 'root\nname'
        root.mkdir()
        self.save(roots=[str(root)])
        for shell in SHELLS.values():
            result = self.run_tool(shell, 'rm', ['-rf', root], match=True)
            self.assertEqual(result.stderr.count(b'\n'), 1)
            self.assertIn(b'root\\nname', result.stderr)

    def test_14c_empty_options_and_parent_removal(self):
        nested = self.home / 'sub' / 'empty'
        nested.mkdir(parents=True)
        for name, shell in SHELLS.items():
            with self.subTest(shell=name):
                self.run_tool(shell, 'rm', ['-rf', '', self.home], match=True)
                self.run_tool(shell, 'rmdir', ['-vp', nested], match=True)
                self.run_tool(shell, 'rmdir', ['--parents', nested], match=True)
                self.run_tool(shell, 'rmdir', [nested], match=False)
                for tool in ['rm', 'rmdir', 'mv', 'shred', 'wipefs', 'mkfs']:
                    self.run_tool(shell, tool, ['--help', self.home], match=False)
                self.run_tool(shell, 'shred', ['-vn', self.home, self.work / 'file'], match=False)
                self.run_tool(shell, 'wipefs', ['-at', self.home, self.work / 'file'], match=False)
                # // MAIN RULING SEAN 1114-WIPE-HYBRID: label is skipped; image formats.
                self.run_tool(shell, 'mkfs.ext4', ['-qL', self.home, self.work / 'image'], match=True)

    def test_14d_reordered_and_invalid_compact_guards(self):
        for shell in SHELLS.values():
            self.guard.write_text(json.dumps(dict(reversed(list(self.data.items())))))
            self.run_tool(shell, 'rm', ['-rf', self.home], match=True)
            self.save()
            # The quick reader can see a root, but full validation must reject
            # the malformed token before attempting a client call.
            self.guard.write_text(self.guard.read_text().replace('"token":"fixture-only"',
                                                               '"token":"bad\\q"'))
            self.run_tool(shell, 'rm', ['-rf', self.home], match=False)
            self.save()

    def test_15_timing(self):
        self.data['realTools']['rm'] = '/bin/rm'
        self.save()
        missing = str(self.work / 'ordinary-missing')
        for name, shell in SHELLS.items():
            deltas = []
            direct = [*shell, '-c', 'exec /bin/rm "$@"', 'rm', '-f', missing]
            shim = [*shell, str(SHIM / 'rm'), '-f', missing]
            for i in range(210):
                measurements = {}
                # Alternate order to avoid a systematic warm-cache advantage.
                for label, command in ([('real', direct), ('shim', shim)] if i % 2 else
                                       [('shim', shim), ('real', direct)]):
                    start = time.perf_counter_ns()
                    result = subprocess.run(command, env=self.env, cwd=self.work,
                                            capture_output=True, timeout=10)
                    measurements[label] = (time.perf_counter_ns() - start) / 1e6
                    self.assertEqual(result.returncode, 0, result.stderr)
                if i >= 10:
                    deltas.append(measurements['shim'] - measurements['real'])
            median = statistics.median(deltas)
            COUNTS['timing'][name] = round(median, 3)
            # // MAIN RULING 1114-WG-SHIM-TIMING: <=10 ms median of 200 runs.
            self.assertEqual(len(deltas), 200)
            self.assertLessEqual(median, 10, f'{name} added median {median:.3f} ms')
        self.assertFalse(self.calls.exists(), 'timing fast path must never call the client')
    def test_16_many_roots_recursive_timing(self):
        self.data['realTools']['rm'] = '/bin/rm'
        self.save(roots=[str(self.home), *[str(self.tree / f'protected-{i}') for i in range(32)]])
        missing = str(self.work / 'ordinary-missing')
        for name, shell in SHELLS.items():
            differences = []
            for i in range(210):
                commands = [('real', [*shell, '-c', 'exec /bin/rm "$@"', 'rm', '-rf', missing]),
                            ('shim', [*shell, str(SHIM / 'rm'), '-rf', missing])]
                measurements = {}
                for label, command in commands if i % 2 else reversed(commands):
                    started = time.perf_counter_ns()
                    result = subprocess.run(command, cwd=self.work, env=self.env,
                                            capture_output=True, timeout=10)
                    measurements[label] = (time.perf_counter_ns() - started) / 1e6
                    self.assertEqual(result.returncode, 0, result.stderr)
                if i >= 10:
                    differences.append(measurements['shim'] - measurements['real'])
            median = statistics.median(differences)
            COUNTS['timing'][name + '-33-roots-recursive'] = round(median, 3)
            # // MAIN RULING 1114-WG-SHIM-TIMING: <=10 ms median of 200 runs.
            self.assertEqual(len(differences), 200)
            self.assertLessEqual(median, 10, f'{name} added median {median:.3f} ms with 33 roots')
        self.assertFalse(self.calls.exists())

    def test_17_sixty_four_roots_timing(self):
        self.data['realTools']['rm'] = '/bin/rm'
        self.save(roots=[str(self.home), *[str(self.tree / f'protected-{i}') for i in range(63)]])
        missing = str(self.work / 'ordinary-missing')
        for name, shell in SHELLS.items():
            differences = []
            for i in range(210):
                commands = [('real', [*shell, '-c', 'exec /bin/rm "$@"', 'rm', '-rf', missing]),
                            ('shim', [*shell, str(SHIM / 'rm'), '-rf', missing])]
                measurements = {}
                for label, command in commands if i % 2 else reversed(commands):
                    started = time.perf_counter_ns()
                    result = subprocess.run(command, cwd=self.work, env=self.env,
                                            capture_output=True, timeout=10)
                    measurements[label] = (time.perf_counter_ns() - started) / 1e6
                    self.assertEqual(result.returncode, 0, result.stderr)
                if i >= 10:
                    differences.append(measurements['shim'] - measurements['real'])
            self.assertEqual(len(differences), 200)
            median = statistics.median(differences)
            COUNTS['timing'][name + '-64-roots-recursive'] = round(median, 3)
            self.assertLessEqual(median, 10, f'{name} added median {median:.3f} ms with 64 roots')
        self.assertFalse(self.calls.exists())

    def test_18_every_packaged_mkfs_variant(self):
        for name, shell in SHELLS.items():
            for tool in [tool for tool in TOOLS if tool == 'mkfs' or tool.startswith('mkfs.')]:
                with self.subTest(shell=name, tool=tool):
                    self.run_tool(shell, tool, [self.work / 'image'], match=True)
                    self.run_tool(shell, tool, ['--help'], match=False)

    def test_19_missing_libraries_fail_open(self):
        copy = self.tree / 'shim-copy'
        shutil.copytree(SHIM, copy, symlinks=True)
        # The missing request encoder is an internal fault after a root match.
        (copy / 'guard-request.sh').unlink()
        for shell in SHELLS.values():
            self.run_tool(shell, 'rm', ['-rf', self.home], shim_dir=copy)
        # With no library at all, the entrypoint still finds the real PATH tool.
        (copy / 'guard-lib.sh').unlink()
        for shell in SHELLS.values():
            self.run_tool(shell, 'rm', ['-rf', self.home], shim_dir=copy)

    def test_20_sixty_four_roots_match_and_benign_control(self):
        roots = [str(self.tree / f'protected-{i}') for i in range(63)] + [str(self.home)]
        self.save(roots=roots)
        for shell in SHELLS.values():
            self.run_tool(shell, 'rm', ['-rf', self.home], match=True)
            self.run_tool(shell, 'rm', ['-rf', self.work / 'missing'])

    def test_21_linear_argv_work(self):
        # Count executed shell operations, rather than wall time on a shared
        # host: doubling an unrelated argv must not rescan earlier operands.
        self.data['realTools']['rm'] = '/bin/true'
        self.save()
        for name, shell in SHELLS.items():
            sizes = []
            for length in [128, 256, 512]:
                args = ['-rf', '--', *[f'missing-{i:05}' for i in range(length)]]
                result = subprocess.run([*shell, '-x', str(SHIM / 'rm'), *args],
                                        cwd=self.work, env=dict(self.env, PS4='+WGTRACE '),
                                        capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr[-1000:])
                self.assertEqual(result.stderr.count(b'wg_canon '), length, name)
                sizes.append(result.stderr.count(b'\n'))
            self.assertLessEqual(sizes[1], sizes[0] * 2.1, name)
            self.assertLessEqual(sizes[2], sizes[1] * 2.1, name)
        self.assertFalse(self.calls.exists())

    def test_23_mkfs_option_arity(self):
        # FAT -I disables safety checks; ext -I takes an inode size.
        # All executables here are recording fakes, including device argv.
        for name, shell in SHELLS.items():
            for tool in ['mkfs.fat', 'mkfs.vfat', 'mkfs.msdos']:
                for flags in [['-I'], ['-vI'], ['-I', '-n', 'Fixture'],
                              ['-InFixture'], ['-I', '--offset', '8']]:
                    args = [*flags, '/dev/sda']
                    with self.subTest(shell=name, tool=tool, flags=flags):
                        self.run_tool(shell, tool, args, match=True)
                        self.assertEqual(records(self.calls)[-1]['targets'], ['/dev/sda'])
                        self.run_tool(shell, tool, args, match=True,
                                      env=dict(self.env, WG_CLIENT_EXIT='0', WG_REAL_EXIT='37'),
                                      status=37)
                for args in [['-n', '/dev/sda'], ['-b8'], ['--offset', '8']]:
                    self.run_tool(shell, tool, args, match=False)
            for tool in ['mkfs.ext2', 'mkfs.ext3', 'mkfs.ext4']:
                self.run_tool(shell, tool, ['-I', '256', '/dev/sda'], match=True)
                self.assertEqual(records(self.calls)[-1]['targets'], ['/dev/sda'])
                self.run_tool(shell, tool, ['-I', '256'], match=False)
                self.run_tool(shell, tool, ['-I256'], match=False)

    def test_24_selected_children_linear_work(self):
        # Exercise the child-coverage loop itself. Exactly half of an existing
        # protected directory is selected in reverse order (no client call).
        self.data['realTools']['rm'] = '/bin/true'
        for name, shell in SHELLS.items():
            sizes = []
            for length in [64, 128, 256]:
                root = self.tree / f'{name}-{length}'
                root.mkdir()
                children = [root / f'child-{i:05}' for i in range(length * 2)]
                for child in children:
                    child.touch()
                self.save(roots=[str(root)])
                result = subprocess.run([*shell, '-x', str(SHIM / 'rm'), '-rf', '--',
                                         *map(str, reversed(children[:length]))],
                                        cwd=self.work, env=dict(self.env, PS4='+WGTRACE '),
                                        capture_output=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr[-1000:])
                self.assertIn(b'wg_children', result.stderr)
                sizes.append(result.stderr.count(b'\n'))
            print('CHILD_WORK ' + json.dumps({'shell': name, 'sizes': sizes}), flush=True)
            self.assertLessEqual(sizes[1], sizes[0] * 2.1, name)
            self.assertLessEqual(sizes[2], sizes[1] * 2.1, name)
        self.assertFalse(self.calls.exists())

    def test_25_profile_variants_runs(self):
        result = subprocess.run([sys.executable, str(SHIM / 'tests' / 'profile_variants.py')],
                                cwd=self.work, env=self.env, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count(b'VARIANT '), 5)

    def test_26_cr_in_protected_root(self):
        root = self.tree / 'cr\rroot'
        root.mkdir()
        self.save(roots=[str(root)])
        self.assertIn('\\r', self.guard.read_text())
        for shell in SHELLS.values():
            self.run_tool(shell, 'rm', ['-rf', root], match=True)
            self.assertEqual(records(self.calls)[-1]['targets'], [str(root)])

    def test_27_crlf_formatted_guard(self):
        self.save(roots=[str(self.home)])
        text = self.guard.read_text()
        self.guard.write_text(text.replace(',', ',\r\n').replace('{', '{\r\n', 1))
        self.assertIn(b'\r\n', self.guard.read_bytes())
        for shell in SHELLS.values():
            self.run_tool(shell, 'rm', ['-rf', self.home], match=True)

    def test_22_compact_reader_boundaries(self):
        for spelling in ['root[bracket]', 'root],"client":[fixture']:
            root = self.tree / spelling
            root.mkdir()
            self.save(roots=[str(root)])
            for shell in SHELLS.values():
                self.run_tool(shell, 'rm', ['-rf', root], match=True)
                self.assertEqual(records(self.calls)[-1]['targets'], [str(root)])
        self.save(roots=[str(self.home)], socket=str(self.tree / 'socket[bracket]'))
        for shell in SHELLS.values():
            self.run_tool(shell, 'rm', ['-rf', self.home], match=True)
        client = self.tree / 'client[bracket].py'
        shutil.copyfile(FIXTURES / 'client.py', client)
        self.save(socket=str(self.tree / 'app.sock'), client=[sys.executable, str(client)])
        for shell in SHELLS.values():
            self.run_tool(shell, 'rm', ['-rf', self.home], match=True)
        self.save(client=[sys.executable, str(FIXTURES / 'client.py')])
        compact = self.guard.read_text()
        for shell in SHELLS.values():
            self.guard.write_text(compact + '\n')
            self.run_tool(shell, 'rm', ['-rf', self.home], match=True)
            self.guard.write_text(compact + '\n{}\n')
            self.run_tool(shell, 'rm', ['-rf', self.home])


if __name__ == '__main__':
    try:
        program = unittest.main(verbosity=2, exit=False)
    finally:
        print('SHIM_RECOUNT ' + json.dumps(COUNTS, sort_keys=True), flush=True)
    raise SystemExit(0 if program.result.wasSuccessful() else 1)
# secret-scan: fixture (generic fixture home names only; no host data)
