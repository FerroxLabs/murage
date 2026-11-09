// Workspace-only structural admission. No compressed pixels are decoded.
export interface WorkspaceImageMetadata { width: number; height: number; frameCount: number; decodedBytes: number }
const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_DECODED_BYTES = 96_000_000;
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function metadata(width: number, height: number, frameCount: number): WorkspaceImageMetadata | undefined {
  if (![width, height, frameCount].every(n => Number.isSafeInteger(n) && n > 0)) return;
  const cost = BigInt(width) * BigInt(height) * BigInt(frameCount) * 4n;
  if (cost > BigInt(MAX_DECODED_BYTES)) return;
  return { width, height, frameCount, decodedBytes: Number(cost) };
}
function png(b: Buffer): WorkspaceImageMetadata | undefined {
  if (b.length < 33 || b.toString('hex', 0, 8) !== '89504e470d0a1a0a') return;
  let width = 0, height = 0, data = false, frames = 0, declared = 0, sequence = 0;
  let frameData = false, defaultFrame = false;
  for (let p = 8; p + 12 <= b.length;) {
    const n = b.readUInt32BE(p), kind = b.toString('ascii', p + 4, p + 8), start = p + 8, end = start + n;
    if (end + 4 > b.length || crc(b.subarray(p + 4, end)) !== b.readUInt32BE(end)) return;
    if (p === 8 && kind !== 'IHDR') return;
    if (kind === 'IHDR') {
      if (p !== 8 || n !== 13) return;
      width = b.readUInt32BE(start); height = b.readUInt32BE(start + 4);
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[b[start + 9]!] ?.includes(b[start + 8]!) || b[start + 10] !== 0 || b[start + 11] !== 0 || b[start + 12]! > 1 || !metadata(width, height, 1)) return;
    } else if (kind === 'acTL') {
      if (declared || data || n !== 8) return;
      declared = b.readUInt32BE(start); if (!declared || !metadata(width, height, declared)) return;
    } else if (kind === 'fcTL') {
      if (!declared || n !== 26 || b.readUInt32BE(start) !== sequence++ || (frames > 0 && !frameData)) return;
      const w = b.readUInt32BE(start + 4), h = b.readUInt32BE(start + 8), x = b.readUInt32BE(start + 12), y = b.readUInt32BE(start + 16);
      if (!w || !h || x + w > width || y + h > height || b[start + 24]! > 2 || b[start + 25]! > 1) return;
      if (!frames && !data) { defaultFrame = true; if (w !== width || h !== height || x || y) return; }
      frames++; frameData = false;
      if (!metadata(width, height, frames + (defaultFrame ? 0 : 1))) return;
    } else if (kind === 'IDAT') {
      if (frames > 1) return;
      data ||= n > 0; if (frames) frameData ||= n > 0;
    } else if (kind === 'fdAT') {
      if (!declared || !frames || !data || n < 5 || b.readUInt32BE(start) !== sequence++) return;
      frameData = true;
    } else if (kind === 'IEND') {
      if (n || !data || b.length - end - 4 > 4096 || (declared && (declared !== frames || !frameData))) return;
      return metadata(width, height, declared ? frames + (defaultFrame ? 0 : 1) : 1);
    }
    p = end + 4;
  }
}
function jpeg(b: Buffer): WorkspaceImageMetadata | undefined {
  if (b.readUInt16BE(0) !== 0xffd8) return;
  let p = 2, width = 0, height = 0, scanned = false;
  while (p < b.length) {
    if (b[p++] !== 255) return;
    while (b[p] === 255) p++;
    const marker = b[p++];
    if (marker === 0xd9) return scanned && b.length - p <= 4096 ? metadata(width, height, 1) : undefined;
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return;
    if (marker === 1) continue;
    if (p + 2 > b.length) return;
    const n = b.readUInt16BE(p); if (n < 2 || p + n > b.length) return;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (n < 8 || n !== 8 + 3 * b[p + 7]!) return;
      height = b.readUInt16BE(p + 3); width = b.readUInt16BE(p + 5);
      if (!metadata(width, height, 1)) return;
    }
    if (marker === 0xda) {
      if (!width || n < 6 || n !== 6 + 2 * b[p + 2]!) return;
      scanned = true; p += n;
      while (p < b.length) {
        if (b[p] !== 255) { p++; continue; }
        let next = p + 1; while (b[next] === 255) next++;
        if (b[next] === 0 || (b[next]! >= 0xd0 && b[next]! <= 0xd7)) { p = next + 1; continue; }
        break;
      }
    } else p += n;
  }
}
function gif(b: Buffer): WorkspaceImageMetadata | undefined {
  if (b.length < 13 || !['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return;
  const width = b.readUInt16LE(6), height = b.readUInt16LE(8);
  let p = 13 + (b[10]! & 128 ? 3 * (2 ** ((b[10]! & 7) + 1)) : 0), frames = 0;
  const blocks = () => { while (p < b.length) { const n = b[p++]!; if (!n) return true; p += n; } return false; };
  while (p < b.length) {
    const kind = b[p++];
    if (kind === 0x3b) return p === b.length ? metadata(width, height, frames) : undefined;
    if (kind === 0x21) { if (p >= b.length) return; p++; if (!blocks()) return; continue; }
    if (kind !== 0x2c || p + 9 > b.length) return;
    const x = b.readUInt16LE(p), y = b.readUInt16LE(p + 2), w = b.readUInt16LE(p + 4), h = b.readUInt16LE(p + 6), flags = b[p + 8]!;
    if (!w || !h || x + w > width || y + h > height || !metadata(width, height, ++frames)) return;
    p += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0);
    if (p >= b.length || b[p]! < 2 || b[p]! > 8) return;
    p++; if (!blocks()) return;
  }
}
function webp(b: Buffer): WorkspaceImageMetadata | undefined {
  if (b.length < 20 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP' || b.readUInt32LE(4) + 8 !== b.length) return;
  let width = 0, height = 0, frames = 0, extended = false, animated = false, anim = false, image = false;
  const picture = (kind: string, p: number, n: number) => {
    if (kind === 'VP8L' && n >= 5 && b[p] === 0x2f && (b[p + 4]! & 0xe0) === 0) { const bits = b.readUInt32LE(p + 1); return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]; }
    if (kind === 'VP8 ' && n >= 10 && !(b[p]! & 1) && b.toString('hex', p + 3, p + 6) === '9d012a') return [b.readUInt16LE(p + 6) & 0x3fff, b.readUInt16LE(p + 8) & 0x3fff];
  };
  for (let p = 12; p < b.length;) {
    if (p + 8 > b.length) return;
    const kind = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4), start = p + 8, end = start + n;
    if (end + (n & 1) > b.length || ((n & 1) && b[end] !== 0)) return;
    if (kind === 'VP8X') {
      if (p !== 12 || n !== 10 || (b[start]! & 0xc1) || b.readUIntLE(start + 1, 3)) return;
      extended = true; animated = !!(b[start]! & 2); width = b.readUIntLE(start + 4, 3) + 1; height = b.readUIntLE(start + 7, 3) + 1;
      if (!metadata(width, height, 1)) return;
    } else if (kind === 'ANIM') { if (!animated || anim || frames || n !== 6) return; anim = true;
    } else if (kind === 'ANMF') {
      if (!animated || !anim || n < 24) return;
      const x = b.readUIntLE(start, 3) * 2, y = b.readUIntLE(start + 3, 3) * 2, w = b.readUIntLE(start + 6, 3) + 1, h = b.readUIntLE(start + 9, 3) + 1;
      if (x + w > width || y + h > height || b[start + 15]! > 3) return;
      let found = false;
      for (let q = start + 16; q < end;) {
        if (q + 8 > end) return;
        const k = b.toString('ascii', q, q + 4), size = b.readUInt32LE(q + 4), stop = q + 8 + size;
        if (stop + (size & 1) > end || ((size & 1) && b[stop] !== 0)) return;
        const dims = picture(k, q + 8, size);
        if (dims) { if (found || dims[0] !== w || dims[1] !== h) return; found = true; }
        else if (k !== 'ALPH' || found || !size) return;
        q = stop + (size & 1);
      }
      if (!found || !metadata(width, height, ++frames)) return;
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      const dims = picture(kind, start, n); if (!dims || image || animated) return;
      if (extended && (dims[0] !== width || dims[1] !== height)) return;
      [width, height] = dims as [number, number]; image = true;
    }
    p = end + (n & 1);
  }
  return animated ? (anim && !image ? metadata(width, height, frames) : undefined) : (image ? metadata(width, height, 1) : undefined);
}
export function workspaceImageMetadata(bytes: Buffer, mime: string): WorkspaceImageMetadata | undefined {
  if (bytes.length < 8 || bytes.length > MAX_BYTES) return;
  try {
    return mime === 'image/png' ? png(bytes) : mime === 'image/jpeg' ? jpeg(bytes) : mime === 'image/gif' ? gif(bytes) : mime === 'image/webp' ? webp(bytes) : undefined;
  } catch { return undefined; }
}
