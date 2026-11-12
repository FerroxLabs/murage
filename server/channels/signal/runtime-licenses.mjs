// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Rebind only generated jar hashes. Upstream licence/POM/notice bytes stay exact.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function stageRuntimeLicenses(source, destination, jars) {
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  const file = join(destination, 'manifest.json'), manifest = JSON.parse(readFileSync(file));
  if (manifest.jars) {
    if (manifest.jars.length !== jars.length) throw Error('License jar inventory differs');
    for (const row of manifest.jars) {
      const jar = jars.find(j => j.path === row.path);
      if (!jar) throw Error('License jar is not shipped');
      row.sha256 = jar.sha256;
    }
    writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  }
}
