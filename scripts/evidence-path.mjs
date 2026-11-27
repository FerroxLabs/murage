// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: source tooling owns path admission; qualification runners own archive
// retention and supply MURAGE_EVIDENCE_ARCHIVE / MURAGE_EVIDENCE_ROOT.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const source = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const contains = (parent, child) => {
  const rel = relative(parent, child);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
};
let preparedInputs;

// Resolve existing ancestors, including aliases of a checkout, before writing.
function physical(path) {
  let ancestor = path;
  while (!existsSync(ancestor)) {
    if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw Error('Evidence path contains a dangling symlink');
    }
    ancestor = dirname(ancestor);
  }
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}
function outsideCheckout(path, repository = source) {
  if (!path || !isAbsolute(path)) throw Error('Evidence requires an absolute directory outside worktrees');
  const dest = physical(resolve(path));
  if (dest === dirname(dest) || contains(resolve('/dev'), dest) || contains(physical(resolve(repository)), dest)) {
    throw Error('Evidence must be outside worktrees and device directories');
  }
  // Reject other worktrees as well as this module's own checkout.
  for (let parent = dest; ; parent = dirname(parent)) {
    if (existsSync(join(parent, '.git'))) throw Error('Evidence must be outside every checkout');
    if (parent === dirname(parent)) break;
  }
  return dest;
}
function under(root, name, admit = outsideCheckout) {
  if (!name || isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw Error('Invalid evidence-relative path');
  const base = admit(root);
  const dest = admit(resolve(base, name));
  if (!contains(base, dest)) throw Error('Evidence path escaped its directory');
  return dest;
}

export function assertExternalEvidencePath(path, repository) {
  const dest = outsideCheckout(path, repository);
  const archive = process.env.MURAGE_EVIDENCE_ARCHIVE ?? preparedInputs;
  if (archive !== undefined) {
    const input = outsideCheckout(archive);
    if (contains(input, dest) || contains(dest, input)) throw Error('Evidence output overlaps the retained archive');
  }
  // A second name for a retained receipt resolves to an innocent pathname; refuse to write through it.
  const stat = lstatSync(dest, { throwIfNoEntry: false });
  if (stat?.isFile() && stat.nlink > 1) throw Error('Evidence target is a hard-linked file');
  return dest;
}

/** Explicit replay archives take precedence over the local pinned test inputs. */
export function archivedEvidencePath(name) {
  if (process.env.MURAGE_EVIDENCE_ARCHIVE !== undefined) return under(process.env.MURAGE_EVIDENCE_ARCHIVE, name);
  if (preparedInputs === undefined) {
    const prepare = fileURLToPath(new URL('prepare-evidence-test-inputs.mjs', import.meta.url));
    const root = execFileSync(process.execPath, [prepare], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
    const { safeWipeSync } = createRequire(import.meta.url)('../server/testing/safe-wipe.mjs');
    process.once('exit', () => safeWipeSync(root, { reason: 'pinned qualification test inputs' }));
    preparedInputs = root;
  }
  return under(preparedInputs, name);
}

/** Fresh captures default to a private temporary directory, inherited by children. */
export function evidencePath(name, directory = process.env.MURAGE_EVIDENCE_ROOT) {
  if (directory === undefined) {
    directory = mkdtempSync(join(outsideCheckout(tmpdir()), 'murage-evidence-'));
    process.env.MURAGE_EVIDENCE_ROOT = directory;
  }
  const dest = under(directory, name, assertExternalEvidencePath);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  return dest;
}

/** Admit a receipt that this run must create; any existing entry is refused, never followed or truncated. */
export function freshEvidencePath(name, directory) {
  const dest = evidencePath(name, directory);
  if (lstatSync(dest, { throwIfNoEntry: false })) throw Error('Evidence target already exists: ' + name);
  return dest;
}

/** Create a fresh receipt exclusively (O_EXCL), so a link planted after admission is refused too. */
export function writeNewEvidence(name, data, directory) {
  const dest = freshEvidencePath(name, directory);
  writeFileSync(dest, data, { flag: 'wx', mode: 0o600 });
  return dest;
}
