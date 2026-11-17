// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Reader inputs only; no archive commands execute.
export const segmentRows: Array<[string, boolean]> = [
  ...['/etc', './out'].flatMap(root => [
    `set --; tar -xf ";" -C ${root}`,
    `set --; unzip ";" -d ${root}`,
    `set --; tar -xf \\; -C ${root}`,
    `set --; tar -xf '&&' --directory=${root}`,
    `set --\ntar -xf "|" -C${root}`,
    `set --; tar -xf "a;b" -C ${root}`,
    `set --\ntar -xf /tmp/a -C ${root}`,
    `set --\nunzip /tmp/a.zip -d ${root}`,
  ].map(command => [command, root === '/etc'] as [string, boolean])),
  ['set --; echo "; touch /etc/x"', false],
];
export const archiveMatrix: Array<[string, string[], string[], string?]> = [
  ...['tar', 'gtar', 'bsdtar'].flatMap(tool => [
    [tool, ['-xf./a', '-C/etc'], ['/etc']],
    [tool, ['xfC', './a', '/etc'], ['/etc']],
    [tool, ['--extract', '--file=./a', '--directory=/etc'], ['/etc']],
    [tool, ['-xOf./a', '-C/etc'], []],
    [tool, ['-tf./a', '-C/etc'], []],
    [tool, ['-df./a', '-C/etc'], []],
    [tool, ['-cf./out', '-C/etc', 'hosts'], ['./out']],
    [tool, ['-cM', '-f/etc/first', '-f./second', './input'], ['/etc/first', './second']],
    [tool, ['-xPf./a', '/etc/hosts'], ['/w', '/etc/hosts']],
    [tool, ['-xPf./a', '../etc/hosts'], ['/w', '/w/../etc/hosts']],
  ] as Array<[string, string[], string[]]>),
  ['unzip', ['./a.zip', '-d/etc'], ['/etc']],
  ['unzip', ['./a.zip', '-d', './out'], ['./out']],
  ['unzip', ['-l', './a.zip', '-d/etc'], []],
  ['unzip', ['-t', './a.zip', '-d/etc'], []],
  ['unzip', ['-p', './a.zip', '-d/etc'], []],
  ['unzip', ['./a.zip', '/etc/hosts'], ['/w', '/etc/hosts']],
  ['cpio', ['-idmv', '-D/etc'], ['/etc']],
  ['cpio', ['--extract', '--directory=/etc'], ['/etc']],
  ['cpio', ['-i'], ['/etc'], '/etc'],
  ['cpio', ['-it', '-D/etc'], []],
  ['cpio', ['-o', '-F/etc/a'], ['/etc/a']],
  ['cpio', ['--create', '--file=/etc/a'], ['/etc/a']],
  ['cpio', ['-p', '/etc'], ['/etc']],
  ...['7z', '7za', '7zr', '7zz'].flatMap(tool => [
    [tool, ['x', './a', '-o/etc'], ['/etc']],
    [tool, ['e', './a', '-o./out'], ['./out']],
    [tool, ['x', './a', '-so', '-o/etc'], []],
    [tool, ['l', './a', '-o/etc'], []],
    [tool, ['t', './a', '-o/etc'], []],
    [tool, ['a', '/etc/a', './in'], ['/etc/a']],
    [tool, ['u', '/etc/a', './in'], ['/etc/a']],
    [tool, ['d', '/etc/a', 'member'], ['/etc/a']],
    [tool, ['x', './a', '/etc/hosts'], ['/w', '/etc/hosts']],
  ] as Array<[string, string[], string[]]>),
];
