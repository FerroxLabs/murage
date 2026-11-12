// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire } from 'node:module';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** Fixed package/source paths only. A renderer never supplies a library name. */
export function loadPasswordNativeAddon({ packaged, resourcesPath, load = createRequire(import.meta.url) }) {
  const file = packaged ? path.join(resourcesPath, 'engine-exclusion.node')
    : fileURLToPath(new URL(`../dist-native/engine-exclusion/${process.platform}-${process.arch}/engine-exclusion.node`, import.meta.url));
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022) || realpathSync(file) !== file) return null;
    const native = load(file);
    return typeof native?.disableCoreDumps === 'function' ? native : null;
  } catch { return null; }
}
