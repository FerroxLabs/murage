// Just enough CBOR (RFC 8949) for an App Attest attestation object: definite
// lengths only, no tags, no floats, depth at most 16. Anything else throws.
export function decodeCbor(bytes: Uint8Array): unknown {
  let at = 0;
  const byte = () => { if (at >= bytes.length) throw new Error("cbor: truncated"); return bytes[at++]; };
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return byte();
    if (info === 25) return (byte() << 8) | byte();
    if (info === 26) return ((byte() << 24) >>> 0) + (byte() << 16) + (byte() << 8) + byte();
    throw new Error("cbor: unsupported length");
  };
  const take = (n: number) => { if (at + n > bytes.length) throw new Error("cbor: truncated"); const out = bytes.slice(at, at + n); at += n; return out; };
  const item = (depth: number): unknown => {
    if (depth > 16) throw new Error("cbor: too deep");
    const initial = byte();
    const major = initial >> 5, info = initial & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("cbor: unsupported simple value");
    }
    const n = length(info);
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: return take(n);
      case 3: return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(take(n));
      case 4: return Array.from({ length: n }, () => item(depth + 1));
      case 5: {
        const map: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const key = item(depth + 1);
          if (typeof key !== "string") throw new Error("cbor: non-text key");
          // A repeated key could hide a second value; __proto__ would reach the prototype.
          if (key === "__proto__" || Object.hasOwn(map, key)) throw new Error("cbor: bad key");
          map[key] = item(depth + 1);
        }
        return map;
      }
      default: throw new Error("cbor: unsupported major type");
    }
  };
  const value = item(0);
  if (at !== bytes.length) throw new Error("cbor: trailing bytes");
  return value;
}
