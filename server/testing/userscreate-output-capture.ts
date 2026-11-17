// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only interception of the actual process writers, including console.*.
// Keep bytes in memory until a generated needle is known; never print a leak.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { HighLevelLeakGuardV2 } from './highlevel-leak-guard-v2.ts';
export function captureUserCreateOutput() {
  const chunks: Buffer[] = [];
  // Vitest installs a console facade that can bypass stdout/stderr. Observe the
  // actual console methods too, before either production or test routing.
  const consoles = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(method => {
    const original = console[method];
    console[method] = (...args: unknown[]) => { chunks.push(Buffer.from(format(...args) + '\n')); };
    return { method, original };
  });
  const writers = [process.stdout, process.stderr].map(stream => {
    const original = stream.write;
    stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk));
      const done = typeof encoding === 'function' ? encoding : callback;
      if (done) queueMicrotask(done);
      return true;
    }) as typeof stream.write;
    return { stream, original };
  });
  return {
    assertClean(guard: HighLevelLeakGuardV2) {
      // Join chunks as well: splitting a credential over multiple writes must fail.
      guard.wrapSink('logging', (value: string) => value)(Buffer.concat(chunks).toString('utf8'));
    },
    restore() {
      for (const { method, original } of consoles) console[method] = original;
      for (const { stream, original } of writers) stream.write = original;
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    },
  };
}
/** Scan all regular artifacts, including hidden files and SQLite/WAL. Empty
 * directories and live Unix sockets contain no file bytes; symlinks fail closed. */
export function userCreateArtifactFiles(roots: readonly string[]): string[] {
  const files: string[] = [];
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Leak evidence is incomplete.');
    if (stat.isDirectory()) for (const child of readdirSync(path)) visit(join(path, child));
    else if (stat.isFile()) files.push(path);
    else if (!stat.isSocket()) throw new Error('Leak evidence is incomplete.');
  };
  for (const root of roots) visit(root);
  if (!files.length) throw new Error('Leak evidence is incomplete.');
  return files;
}
