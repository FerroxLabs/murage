// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Only fixture files beneath this invocation's evidence directory are touched.
const root = mkdtempSync(join(process.argv[2], 'prerequisites-'));
try {
  const require = createRequire(import.meta.url);
  const addon = require(fileURLToPath(new URL(`../../dist-native/engine-exclusion/win32-${process.arch}/engine-exclusion.node`, import.meta.url)));
  if (addon.version?.() !== 11 || ['jobCreate', 'jobAssign', 'jobClose', 'jobStop', 'dropShutdownPrivileges'].some(name => typeof addon[name] !== 'function')) throw Error('Build the current engine-exclusion addon before running this gate');
  execFileSync('git', ['--version'], { windowsHide: true, stdio: 'pipe' });
  writeFileSync(join(root, 'file.txt'), 'fixture');
  symlinkSync(join(root, 'file.txt'), join(root, 'file-link'), 'file');
  mkdirSync(join(root, 'folder'));
  symlinkSync(join(root, 'folder'), join(root, 'junction'), 'junction');
  if (readFileSync(join(root, 'file-link'), 'utf8') !== 'fixture') throw Error('File symlink did not resolve');
} finally {
  // Each entry is removed separately, so a junction target is never traversed.
  for (const file of ['file-link', 'file.txt']) { try { unlinkSync(join(root, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  for (const dir of ['junction', 'folder']) { try { rmdirSync(join(root, dir)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  rmdirSync(root);
}
