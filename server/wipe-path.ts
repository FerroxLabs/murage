// SPDX-License-Identifier: AGPL-3.0-or-later
import { accessSync, constants, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, parse } from 'node:path';

/** Resolve each component, including symlink contents, before consuming '..'.
 * Missing argv probes are absent; strict write-target resolution throws.
 * Delete operands may be absent only when no later parent traversal remains.
 * A new write destination may be absent, but a followed link or a remaining
 * parent traversal still needs complete resolution. */
export function physicalWipePath(token: string, cwd?: string, allowAbsent: boolean | 'delete' | 'write' = false, followFinal = true): string | undefined {
  if (!isAbsolute(token) && (!cwd || !isAbsolute(cwd))) throw new Error('wipe-path-unknown-cwd');
  const path = isAbsolute(token) ? token : cwd!.replace(/\/$/, '') + '/' + token;
  const separators = process.platform === 'win32' ? /[\\/]/ : /\//;
  const trailing = (value: string) => separators.test(value.slice(-1));
  type Component = { part: string } | { endLink: true };
  const components = (value: string): Component[] => value.split(separators).filter(Boolean).map(part => ({ part }));
  const root = parse(path).root;
  let physical = realpathSync.native(root), hops = 0, links = 0;
  const stack = components(path.slice(root.length)).reverse();
  let remaining = stack.length;
  while (stack.length) {
    const component = stack.pop()!;
    if ('endLink' in component) { links--; continue; }
    remaining--;
    const prefix = (trailing(physical) ? physical.slice(0, -1) : physical) + '/' + component.part;
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(prefix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (allowAbsent === 'delete' && !stack.some(next => 'part' in next && next.part === '..')) return undefined;
        if (allowAbsent === 'write' && links === 0 && !stack.some(next => 'part' in next && next.part === '..')) return undefined;
        if (allowAbsent === true && links === 0) return undefined;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (!followFinal && remaining === 0 && !trailing(token)) return prefix;
      if (++hops > 40) throw Object.assign(new Error('wipe-path-link-loop'), { code: 'ELOOP' });
      const target = readlinkSync(prefix), targetRoot = parse(target).root;
      const parts = components(target.slice(targetRoot.length));
      // A slash in link contents requires traversal even when it is final.
      if (trailing(target)) parts.push({ part: '.' });
      if (targetRoot) physical = realpathSync.native(targetRoot);
      links++; stack.push({ endLink: true }, ...parts.reverse()); remaining += parts.length;
      continue;
    }
    physical = realpathSync.native(prefix);
    if (remaining > 0 || trailing(token)) {
      if (!stat.isDirectory()) throw new Error('wipe-path-non-directory-prefix');
      accessSync(physical, constants.X_OK);
    }
  }
  return physical;
}
