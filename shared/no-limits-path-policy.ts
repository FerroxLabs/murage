// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { SENSITIVE_PATHS } from './sensitive-paths.ts';

/** Concrete policy names only. Patterns describe policy; they cannot enumerate
 * inodes. This metadata never walks /etc, a home, or a project. */
export const NO_LIMITS_SYSTEM_FILES = [
  '/etc/hosts', '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow',
  '/etc/sudoers', '/etc/fstab', '/etc/resolv.conf', '/etc/hostname',
  '/private/etc/hosts', '/private/etc/passwd',
] as const;
export const NO_LIMITS_HOME_FILES = [
  '.ssh/config', '.ssh/authorized_keys', '.ssh/id_rsa', '.ssh/id_ed25519', '.ssh/id_ecdsa',
  '.kube/config', '.git-credentials', '.pgpass',
] as const;

export function noLimitsNamedFiles(home: string, cwd?: string, runtimeFiles: readonly string[] = [], named: readonly string[] = []): readonly string[] {
  const files: string[] = [...NO_LIMITS_SYSTEM_FILES, ...NO_LIMITS_HOME_FILES.map(path => `${home}/${path}`)];
  for (const row of SENSITIVE_PATHS) for (const spelling of row.read) {
    if (/[*?{}[\]]/.test(spelling)) continue;
    if (spelling.startsWith('~/')) files.push(home + spelling.slice(1));
    else if (spelling.startsWith('/')) files.push(spelling);
    else if (cwd) files.push(`${cwd}/${spelling}`);
  }
  files.push(...runtimeFiles, ...named);
  return Object.freeze([...new Set(files)]);
}
