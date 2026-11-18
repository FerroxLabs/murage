// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw Error('Malformed executable'); };
const bounds = (b, offset, size) => { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > b.length) fail(); };
export function executableFormat(b) {
  if (b.length < 4) return null;
  if (b.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70]))) return 'elf';
  if (b[0] === 77 && b[1] === 90) return 'pe';
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(b.readUInt32BE(0))) return 'macho';
  return null;
}
function macho(b) {
  const magic = b.readUInt32BE(0);
  if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
    const le = magic === 0xbebafeca || magic === 0xbfbafeca, wide = magic === 0xcafebabf || magic === 0xbfbafeca;
    const u32 = off => { bounds(b, off, 4); return le ? b.readUInt32LE(off) : b.readUInt32BE(off); };
    const u64 = off => { bounds(b, off, 8); return Number(le ? b.readBigUInt64LE(off) : b.readBigUInt64BE(off)); };
    const count = u32(4), stride = wide ? 32 : 20;
    bounds(b, 8, count * stride);
    const parts = [], spans = [];
    for (let i = 0; i < count; i++) {
      const at = 8 + i * stride, offset = wide ? u64(at + 8) : u32(at + 8), size = wide ? u64(at + 16) : u32(at + 12);
      bounds(b, offset, size);
      if (offset < 8 + count * stride || spans.some(([start, end]) => offset < end && offset + size > start)) fail();
      spans.push([offset, offset + size]);
      parts.push([u32(at), u32(at + 4), digest(macho(b.subarray(offset, offset + size)))]);
    }
    return Buffer.from(JSON.stringify(parts));
  }
  const le = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const wide = magic === 0xfeedfacf || magic === 0xcffaedfe;
  if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) fail();
  const u32 = off => { bounds(b, off, 4); return le ? b.readUInt32LE(off) : b.readUInt32BE(off); };
  const header = wide ? 32 : 28, count = u32(16), commands = u32(20);
  bounds(b, header, commands);
  const copy = Buffer.from(b), mask = (at, size) => { bounds(copy, at, size); copy.fill(0, at, at + size); };
  let at = header, end = b.length, signatures = 0;
  for (let i = 0; i < count; i++) {
    const command = u32(at), size = u32(at + 4);
    if (size < 8 || size % 4 || at + size > header + commands) fail();
    if (command === 0x1d) {
      if (++signatures !== 1 || size !== 16) fail();
      end = u32(at + 8);
      const signatureSize = u32(at + 12);
      bounds(b, end, signatureSize);
      if (end < header + commands || end + signatureSize !== b.length) fail();
      mask(at, size);
    }
    if (command === (wide ? 0x19 : 0x1) && b.subarray(at + 8, at + 24).toString().replace(/\0.*$/, '') === '__LINKEDIT') {
      if (size < (wide ? 72 : 56)) fail();
      mask(at + (wide ? 32 : 28), wide ? 8 : 4); // vmsize
      mask(at + (wide ? 48 : 36), wide ? 8 : 4); // filesize
    }
    at += size;
  }
  if (at !== header + commands) fail();
  mask(16, 8); // ncmds + sizeofcmds; the remaining commands stay authenticated.
  // codesign aligns the signature to 16 bytes. Canonicalise that zero padding
  // for unsigned files too; never remove or ignore any non-signature byte.
  const result = Buffer.alloc(Math.ceil(end / 16) * 16);
  copy.copy(result, 0, 0, end);
  return result;
}
function pe(b) {
  bounds(b, 0x3c, 4);
  const header = b.readUInt32LE(0x3c); bounds(b, header, 24);
  if (b.readUInt32LE(header) !== 0x4550) fail();
  const optional = header + 24, length = b.readUInt16LE(header + 20);
  bounds(b, optional, length);
  const magic = b.readUInt16LE(optional), directory = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : fail());
  const checksum = optional + 64, certificate = directory + 4 * 8;
  if (certificate + 8 > optional + length) fail();
  const offset = b.readUInt32LE(certificate), size = b.readUInt32LE(certificate + 4);
  if ((offset === 0) !== (size === 0)) fail();
  if (size && (offset % 8 || offset < optional + length || offset + size !== b.length)) fail();
  bounds(b, offset, size);
  const end = size ? offset : b.length;
  // Authenticode omits the checksum, security directory and certificate table.
  // Signers append zero padding to an eight-byte boundary before the table.
  const tail = Buffer.alloc(Math.ceil(end / 8) * 8 - (certificate + 8));
  b.copy(tail, 0, certificate + 8, end);
  return Buffer.concat([b.subarray(0, checksum), b.subarray(checksum + 4, certificate), tail]);
}
export function normalizedDigest(bytes, format = executableFormat(bytes)) {
  if (format === 'elf') return digest(bytes);
  if (format === 'macho') return digest(macho(bytes));
  if (format === 'pe') return digest(pe(bytes));
  throw Error('Unknown executable format');
}

/** TeamIdentifier is inside the signed CodeDirectory. Every architecture and
 * every alternate CodeDirectory must name the same pinned team. The platform
 * probe subsequently validates those signature bytes against Apple's trust. */
export function machoTeamIdentifiers(bytes) {
  const teams = [];
  const walk = b => {
    bounds(b,0,8); const magic=b.readUInt32BE(0);
    if ([0xcafebabe,0xbebafeca,0xcafebabf,0xbfbafeca].includes(magic)) {
      const le=magic===0xbebafeca||magic===0xbfbafeca,wide=magic===0xcafebabf||magic===0xbfbafeca;
      const u32=o=>{bounds(b,o,4);return le?b.readUInt32LE(o):b.readUInt32BE(o);};
      const u64=o=>{bounds(b,o,8);return Number(le?b.readBigUInt64LE(o):b.readBigUInt64BE(o));};
      const count=u32(4),stride=wide?32:20;bounds(b,8,count*stride);
      if(!count)fail();
      for(let i=0;i<count;i++){const at=8+i*stride,off=wide?u64(at+8):u32(at+8),size=wide?u64(at+16):u32(at+12);bounds(b,off,size);walk(b.subarray(off,off+size));}
      return;
    }
    if(![0xfeedface,0xfeedfacf,0xcefaedfe,0xcffaedfe].includes(magic))fail();
    const le=magic===0xcefaedfe||magic===0xcffaedfe,wide=magic===0xfeedfacf||magic===0xcffaedfe;
    const u32=o=>{bounds(b,o,4);return le?b.readUInt32LE(o):b.readUInt32BE(o);};
    const count=u32(16);let at=wide?32:28,signature;
    for(let i=0;i<count;i++){const cmd=u32(at),size=u32(at+4);bounds(b,at,size);if(size<8)fail();if(cmd===0x1d){if(signature)fail();const off=u32(at+8),len=u32(at+12);bounds(b,off,len);signature=b.subarray(off,off+len);}at+=size;}
    if(!signature)fail();bounds(signature,0,12);
    if(signature.readUInt32BE(0)!==0xfade0cc0)fail();
    const length=signature.readUInt32BE(4),entries=signature.readUInt32BE(8);bounds(signature,0,length);bounds(signature,12,entries*8);
    let found=0;
    for(let i=0;i<entries;i++){
      const offset=signature.readUInt32BE(16+i*8);bounds(signature,offset,12);
      if(signature.readUInt32BE(offset)!==0xfade0c02)continue;
      const size=signature.readUInt32BE(offset+4);bounds(signature,offset,size);const cd=signature.subarray(offset,offset+size);bounds(cd,0,52);
      if(cd.readUInt32BE(8)<0x20200)fail();const team=cd.readUInt32BE(48);if(!team)fail();bounds(cd,team,1);
      const end=cd.indexOf(0,team);if(end<0)fail();teams.push(cd.subarray(team,end).toString('utf8'));found++;
    }
    if(!found)fail();
  };
  walk(bytes);return teams;
}
