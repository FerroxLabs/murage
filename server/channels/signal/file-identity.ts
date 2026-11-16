// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
const nativeFs = createRequire(import.meta.url)('node:fs') as typeof fs;

/** Only dev/ino are identities. Never round them through a JavaScript number. */
export type IdentityStat = Omit<fs.Stats, 'dev' | 'ino'> & { dev: string; ino: string };
export type IdentityStatReader = (path: string, options: { bigint: true }) => fs.BigIntStats | fs.Stats | IdentityStat;

function decimal(value: bigint | number | string): string {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('unsafe file identity');
  // Node exposes Windows' 64-bit file IDs through signed BigIntStats fields.
  // Preserve their bits so signed reads match existing unsigned journal IDs.
  const text = String(typeof value === 'bigint' ? BigInt.asUintN(64, value) : value);
  if (!/^\d+$/.test(text)) throw new Error('unsafe file identity');
  return text;
}

function milliseconds(stat: fs.BigIntStats | fs.Stats | IdentityStat, field: 'atime' | 'mtime' | 'ctime' | 'birthtime'): number {
  const ns = `${field}Ns` as const;
  if (typeof stat[`${field}Ms`] === 'bigint' && ns in stat) {
    const value = (stat as fs.BigIntStats)[ns];
    // Match Stats' seconds + fractional milliseconds, preserving sub-ms
    // change detection rather than truncating BigIntStats' integer *Ms.
    return Number(value / 1_000_000_000n) * 1000 + Number(value % 1_000_000_000n) / 1_000_000;
  }
  return Number(stat[`${field}Ms`]);
}

/** Keep the existing numeric metadata API, with methods bound to the native
 * stat so BigIntStats' mode predicates continue to use their bigint fields. */
export function identityStat(stat: fs.BigIntStats | fs.Stats | IdentityStat): IdentityStat {
  return {
    ...stat, dev: decimal(stat.dev), ino: decimal(stat.ino),
    mode: Number(stat.mode), nlink: Number(stat.nlink), uid: Number(stat.uid), gid: Number(stat.gid),
    rdev: Number(stat.rdev), size: Number(stat.size), blksize: Number(stat.blksize), blocks: Number(stat.blocks),
    atimeMs: milliseconds(stat, 'atime'), mtimeMs: milliseconds(stat, 'mtime'),
    ctimeMs: milliseconds(stat, 'ctime'), birthtimeMs: milliseconds(stat, 'birthtime'),
    isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink(),
    isBlockDevice: () => stat.isBlockDevice(), isCharacterDevice: () => stat.isCharacterDevice(),
    isFIFO: () => stat.isFIFO(), isSocket: () => stat.isSocket(),
  };
}

export function lstatIdentity(path: string, read: IdentityStatReader = fs.lstatSync): IdentityStat {
  let stat = read(path, { bigint: true });
  if ((typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint') && read === fs.lstatSync) {
    stat = nativeFs.lstatSync(path, { bigint: true });
  }
  if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint') {
    throw new Error('identity reader must honour bigint: dev and ino must be bigint');
  }
  return identityStat(stat);
}

export function fstatIdentity(fd: number, read: (fd: number, options: { bigint: true }) => fs.BigIntStats | fs.Stats | IdentityStat = fs.fstatSync): IdentityStat {
  let stat = read(fd, { bigint: true });
  if ((typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint') && read === fs.fstatSync) {
    stat = nativeFs.fstatSync(fd, { bigint: true });
  }
  if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint') {
    throw new Error('identity reader must honour bigint: dev and ino must be bigint');
  }
  return identityStat(stat);
}
