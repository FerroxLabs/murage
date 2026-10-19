// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-home ed25519 key pair in the OpenSSH formats (private: openssh-key-v1, unencrypted; public: authorized_keys line).
// No imports on purpose: a plain Node script can load this file to check the output with ssh-keygen.
const enc = new TextEncoder();
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const str = (b: Uint8Array) => cat(u32(b.length), b);
const b64 = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };

export async function generateOpenSshEd25519(comment: string): Promise<{ privateKey: string; publicKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const seed = pkcs8.slice(pkcs8.length - 32);
  const pubBlob = cat(str(enc.encode("ssh-ed25519")), str(pub));
  const check = crypto.getRandomValues(new Uint8Array(4));
  const priv = cat(check, check, str(enc.encode("ssh-ed25519")), str(pub), str(cat(seed, pub)), str(enc.encode(comment)));
  const pad = new Uint8Array((8 - (priv.length % 8)) % 8).map((_, i) => i + 1);
  const body = cat(enc.encode("openssh-key-v1\0"), str(enc.encode("none")), str(enc.encode("none")), str(new Uint8Array()),
    u32(1), str(pubBlob), str(cat(priv, pad)));
  const wrapped = b64(body).match(/.{1,70}/g)!.join("\n");
  return { privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${b64(pubBlob)} ${comment}\n` };
}
