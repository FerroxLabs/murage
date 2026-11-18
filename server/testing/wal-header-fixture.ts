// SPDX-License-Identifier: AGPL-3.0-or-later
import { endianness } from "node:os";

/** A checksummed SQLite wal-index header for worker VM fixtures. */
export function walIndexFixture(salt1: number, salt2: number, frames: number, backfill = frames): Buffer {
  const b = Buffer.alloc(100), little = endianness() === "LE";
  const put = (n: number, off: number) => little ? b.writeUInt32LE(n, off) : b.writeUInt32BE(n, off);
  put(3007000, 0); b[12] = 1;
  little ? b.writeUInt16LE(4096, 14) : b.writeUInt16BE(4096, 14);
  put(frames, 16); b.writeUInt32BE(salt1, 32); b.writeUInt32BE(salt2, 36);
  let a = 0, c = 0;
  for (let off = 0; off < 40; off += 8) {
    a = (a + (little ? b.readUInt32LE(off) : b.readUInt32BE(off)) + c) >>> 0;
    c = (c + (little ? b.readUInt32LE(off + 4) : b.readUInt32BE(off + 4)) + a) >>> 0;
  }
  put(a, 40); put(c, 44); b.copy(b, 48, 0, 48); put(backfill, 96);
  return b;
}

/** A checksummed WAL header using SQLite's little-endian checksum format. */
export function walHeaderFixture(salt1: number, salt2: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(0x377f0682, 0); b.writeUInt32BE(3007000, 4); b.writeUInt32BE(4096, 8);
  b.writeUInt32BE(salt1, 16); b.writeUInt32BE(salt2, 20);
  let a = 0, c = 0;
  for (let off = 0; off < 24; off += 8) {
    a = (a + b.readUInt32LE(off) + c) >>> 0;
    c = (c + b.readUInt32LE(off + 4) + a) >>> 0;
  }
  b.writeUInt32BE(a, 24); b.writeUInt32BE(c, 28);
  return b;
}
