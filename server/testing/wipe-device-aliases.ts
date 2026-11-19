// SPDX-License-Identifier: AGPL-3.0-or-later
export const deviceAliases = ['sda', 'nvme0n1', 'disk/by-id/device-fixture'].flatMap(name => [
  `/dev/${name}`, `/./dev/${name}`, `//dev/${name}`, `/dev//${name}`,
  `/dev/./${name}`, `/dev/../dev/${name}`, `/tmp/../dev/${name}`, `/dev/${name}/`,
]);
export const deviceContexts = [
  { name: 'POSIX', platform: 'linux', dialect: 'sh', cwd: '/work/project' },
  { name: 'pwsh', platform: 'win32', dialect: 'pwsh', cwd: 'D:/work/project' },
  { name: 'Git Bash', platform: 'win32', dialect: 'sh', cwd: 'D:/work/project' },
] as const;
export function deviceCommands(dialect: 'sh' | 'pwsh'): string[] {
  return deviceAliases.flatMap(path => [path, `'${path}'`, `"${path}"`, path.replace('dev', dialect === 'pwsh' ? 'd`ev' : 'd\\ev')]
    .flatMap(operand => [`dd if=/dev/zero of=${operand}`, `cat blob > ${operand}`]));
}
