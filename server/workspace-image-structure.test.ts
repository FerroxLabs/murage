import { describe, expect, it } from 'vitest';
import { workspaceImageMetadata } from './workspace-image-structure.ts';
import { structuralPng, pngChunk, be32 } from './testing/workspace-image-fixtures.ts';
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const chunk = (kind: string, b: Buffer) => Buffer.concat([Buffer.from(kind), le32(b.length), b, ...(b.length & 1 ? [Buffer.alloc(1)] : [])]);
const riff = (b: Buffer) => Buffer.concat([Buffer.from('RIFF'), le32(b.length + 4), Buffer.from('WEBP'), b]);
const vp8l = chunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0, 0]));
const gif = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex');
const jpeg = Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0011ff00ffd011ffd9', 'hex');
describe('S2 bounded workspace structure without pixel decoding', () => {
  const examples = [['image/png', structuralPng(1, 1)], ['image/gif', gif], ['image/jpeg', jpeg], ['image/webp', riff(vp8l)]] as const;
  it.each(examples)('S2 accepts complete %s and rejects every truncated prefix', (mime, bytes) => {
    expect(workspaceImageMetadata(bytes, mime)).toEqual({ width: 1, height: 1, frameCount: 1, decodedBytes: 4 });
    for (let n = 0; n < bytes.length; n++) expect(workspaceImageMetadata(bytes.subarray(0, n), mime), `prefix ${n}`).toBeUndefined();
  });
  it('S2 checks PNG CRC and top-level end, tolerating at most 4096 trailing bytes', () => {
    const b = structuralPng(1, 1), corrupt = Buffer.from(b); corrupt[29] = corrupt[29]! ^ 1;
    expect(workspaceImageMetadata(corrupt, 'image/png')).toBeUndefined();
    expect(workspaceImageMetadata(Buffer.concat([b, Buffer.alloc(100)]), 'image/png')).toBeDefined();
    expect(workspaceImageMetadata(Buffer.concat([b, Buffer.alloc(4097)]), 'image/png')).toBeUndefined();
    expect(workspaceImageMetadata(Buffer.concat([jpeg.subarray(0, 2), Buffer.from('ffe10006ffd90000', 'hex'), jpeg.subarray(2, -2)]), 'image/jpeg')).toBeUndefined();
    expect(workspaceImageMetadata(Buffer.concat([jpeg, Buffer.alloc(100)]), 'image/jpeg')).toBeDefined();
  });
  it('R2-G3 refuses VP8X-only and current-length RIFF with incomplete nested frames', () => {
    const extended = chunk('VP8X', Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(workspaceImageMetadata(riff(extended), 'image/webp')).toBeUndefined();
    const anim = chunk('ANIM', Buffer.alloc(6));
    const frame = chunk('ANMF', Buffer.concat([Buffer.alloc(16), vp8l]));
    expect(workspaceImageMetadata(riff(Buffer.concat([extended, anim, frame])), 'image/webp')).toMatchObject({ frameCount: 1 });
    const broken = chunk('ANMF', Buffer.concat([Buffer.alloc(16), vp8l.subarray(0, -2)]));
    expect(workspaceImageMetadata(riff(Buffer.concat([extended, anim, broken])), 'image/webp')).toBeUndefined();
    expect(workspaceImageMetadata(riff(Buffer.concat([extended, anim, frame, frame])), 'image/webp')).toMatchObject({ frameCount: 2, decodedBytes: 8 });
  });
  it('S2 counts full-canvas APNG frames and rejects bad sequence/count/bounds', () => {
    const base = structuralPng(1, 1), ihdr = base.subarray(0, 33), end = pngChunk('IEND', Buffer.alloc(0));
    const control = (seq: number) => pngChunk('fcTL', Buffer.concat([be32(seq), be32(1), be32(1), Buffer.alloc(12), Buffer.alloc(2)]));
    const frame = pngChunk('IDAT', Buffer.from([1]));
    const file = (declared: number, seq: number) => Buffer.concat([ihdr, pngChunk('acTL', Buffer.concat([be32(declared), be32(0)])), control(0), frame, control(seq), pngChunk('fdAT', Buffer.concat([be32(2), Buffer.from([1])])), end]);
    expect(workspaceImageMetadata(file(2, 1), 'image/png')).toMatchObject({ frameCount: 2, decodedBytes: 8 });
    expect(workspaceImageMetadata(file(3, 1), 'image/png')).toBeUndefined();
    expect(workspaceImageMetadata(file(2, 7), 'image/png')).toBeUndefined();
  });
});
