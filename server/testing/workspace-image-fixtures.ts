import { deflateSync } from 'node:zlib';
export const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
export function pngChunk(kind: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind), data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  return Buffer.concat([be32(data.length), body, be32((crc ^ 0xffffffff) >>> 0)]);
}
export function structuralPng(width = 3, height = 2, padding = 64): Buffer {
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', Buffer.concat([be32(width), be32(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk('tEXt', Buffer.alloc(padding, 0x11)),
    pngChunk('IDAT', deflateSync(Buffer.alloc(Math.min(1_000_000, height * (1 + width * 4))))), pngChunk('IEND', Buffer.alloc(0))]);
}
