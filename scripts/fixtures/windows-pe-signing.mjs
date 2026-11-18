// Synthetic format fixtures only. Trust verification is injected separately.
export function unsignedPeFixture(machine = 0x8664, length = 1537) {
  const bytes = Buffer.alloc(length);
  bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(machine, 68); bytes.writeUInt16LE(240, 84); bytes.writeUInt16LE(0x20b, 88);
  bytes.writeUInt16LE(2, 70); bytes.writeUInt16LE(0x22, 86);
  bytes.writeUInt32LE(512, 92); bytes.writeUInt32LE(512, 96);
  bytes.writeUInt32LE(0x1000, 104); bytes.writeUInt32LE(0x1000, 108);
  bytes.writeBigUInt64LE(0x140000000n, 112); bytes.writeUInt32LE(0x1000, 120); bytes.writeUInt32LE(512, 124);
  bytes.writeUInt32LE(0x3000, 144); bytes.writeUInt32LE(512, 148); bytes.writeUInt16LE(2, 156);
  for (const [index, name, offset, flags] of [[0, ".text", 512, 0x60000020], [1, ".rsrc", 1024, 0x40000040]]) {
    const section = 328 + index * 40; bytes.write(name, section);
    bytes.writeUInt32LE(512, section + 8); bytes.writeUInt32LE((index + 1) * 0x1000, section + 12);
    bytes.writeUInt32LE(512, section + 16); bytes.writeUInt32LE(offset, section + 20); bytes.writeUInt32LE(flags, section + 36);
  }
  bytes.fill(0x90, 512, Math.min(1024, length));
  if (length > 1024) bytes.fill(0x52, 1024, Math.min(1536, length));
  bytes.writeUInt32LE(16, 196); bytes[length - 1] = 42;
  return bytes;
}
export function appendPeFixtureCertificate(original) {
  const offset = Math.ceil(original.length / 8) * 8, bytes = Buffer.alloc(offset + 16);
  original.copy(bytes); bytes.writeUInt32LE(1234, 152);
  bytes.writeUInt32LE(offset, 232); bytes.writeUInt32LE(16, 236);
  bytes.writeUInt32LE(16, offset); bytes.writeUInt16LE(0x200, offset + 4); bytes.writeUInt16LE(2, offset + 6);
  return bytes;
}
