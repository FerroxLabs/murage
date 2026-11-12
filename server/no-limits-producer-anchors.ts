// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Paths are already spelled by the shared resolver. Do not turn literal
 * POSIX backslashes into separators, or climb above a drive/UNC share root. */
export function producerParent(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const root = /^[a-z]:\//i.exec(path)?.[0] ?? /^\/\/[^/]+\/[^/]+/.exec(path)?.[0] ?? (path.startsWith('/') ? '/' : '.');
  if (!clean || clean === root || clean === root.replace(/\/$/, '')) return root;
  const slash = clean.lastIndexOf('/');
  const parent = slash < 0 ? '.' : clean.slice(0, slash) || '/';
  return root !== '.' && parent.length <= root.replace(/\/$/, '').length ? root : parent;
}
