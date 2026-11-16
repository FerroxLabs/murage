// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export type SealKind = "held" | "refresh" | "access" | "runtime-key";
export interface Sealer {
  seal(kind: SealKind, recordId: string, version: number, plain: Uint8Array): Promise<string>;
  open(kind: SealKind, recordId: string, version: number, sealed: string): Promise<Uint8Array | null>;
}
const utf8 = new TextEncoder();
export function encode64(bytes: Uint8Array): string { return btoa(Array.from(bytes, c => String.fromCharCode(c)).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,''); }
export function decode64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 100_000) throw Error('invalid_request');
  const bytes = Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
  if (encode64(bytes) !== value) throw Error('invalid_request'); return bytes;
}
export async function sha256(value: Uint8Array | string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value === 'string' ? utf8.encode(value) : new Uint8Array(value))),b=>b.toString(16).padStart(2,'0')).join('');
}
export function equalHash(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  let difference = 0; for (let i=0;i<64;i++) difference |= a.charCodeAt(i)^b.charCodeAt(i); return difference === 0;
}
export async function hkdf(material: Uint8Array, label: string, length = 32): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw',new Uint8Array(material),'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:utf8.encode('murage-crm-v1'),info:utf8.encode(label)},key,length*8));
}
function sealer(material: Uint8Array, namespace: string): Sealer {
  const keyFor = async (kind: SealKind) => crypto.subtle.importKey('raw',await hkdf(material,`${namespace}:${kind}`),'AES-GCM',false,['encrypt','decrypt']);
  const aad = (kind: SealKind,id: string,v: number) => utf8.encode(`crm/v1|${kind}|${id}|${v}`);
  return {
    async seal(kind,id,v,plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(kind,id,v)},await keyFor(kind),new Uint8Array(plain));
      return `${encode64(iv)}.${encode64(new Uint8Array(encrypted))}`;
    },
    async open(kind,id,v,sealed) {
      try { const [iv,data,...extra] = sealed.split('.'); if (extra.length || !iv || !data || decode64(iv).length !== 12) return null;
        return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(iv),additionalData:aad(kind,id,v)},await keyFor(kind),decode64(data)));
      } catch { return null; }
    },
  };
}
export function masterSealer(masterKeyB64u: string): Sealer {
  const material = decode64(masterKeyB64u); if (material.length !== 32) throw Error('invalid_request'); return sealer(material,'master');
}
export function capabilitySealer(capability: string): Sealer {
  const material = decode64(capability); if (material.length !== 32) throw Error('invalid_request'); return sealer(material,'capability');
}
/** Encrypt-only callback recipient; no capability or decrypt key at rest. */
export async function createHeldRecipient(capability: string, flowId: string): Promise<{recipientPublic: string;recipientPrivateSealed:string}> {
  const pair = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey));
  return {recipientPublic:encode64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey))),
    recipientPrivateSealed:await capabilitySealer(capability).seal('held',flowId,1,privateBytes)};
}
export async function sealHeld(recipientPublic: string,flowId: string,plain: Uint8Array): Promise<string> {
  const recipient = await crypto.subtle.importKey('raw',decode64(recipientPublic),{name:'ECDH',namedCurve:'P-256'},false,[]);
  const ephemeral = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:recipient},ephemeral.privateKey,256));
  const pub = encode64(new Uint8Array(await crypto.subtle.exportKey('raw',ephemeral.publicKey)));
  return `${pub}:${await sealer(shared,'callback').seal('held',flowId,1,plain)}`;
}
export async function openHeld(capability: string,flowId: string,privateSealed: string,sealed: string): Promise<Uint8Array | null> {
  try {
    const privateBytes = await capabilitySealer(capability).open('held',flowId,1,privateSealed); if (!privateBytes) return null;
    const privateKey = await crypto.subtle.importKey('pkcs8',new Uint8Array(privateBytes),{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
    const [pub,data,...extra] = sealed.split(':'); if (!pub || !data || extra.length) return null;
    const publicKey = await crypto.subtle.importKey('raw',decode64(pub),{name:'ECDH',namedCurve:'P-256'},false,[]);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:publicKey},privateKey,256));
    return await sealer(shared,'callback').open('held',flowId,1,data);
  } catch { return null; }
}
