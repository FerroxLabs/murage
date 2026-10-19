// SPDX-License-Identifier: AGPL-3.0-or-later
export interface KeyWrapper {
  wrap(homeId: string, bytes: Uint8Array<ArrayBuffer>): Promise<string>;
  unwrap(homeId: string, wrapped: string): Promise<Uint8Array<ArrayBuffer>>;
}

export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function stagingKeyWrapper(secret: string | undefined): KeyWrapper {
  // Import per request; the KEK is non-extractable and never returned or logged.
  const raw = decode(secret ?? "");
  if (raw.length !== 32) throw new Error("cloud_key_unavailable");
  const key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return {
    async wrap(homeId, bytes) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
        name: "AES-GCM", iv, additionalData: new TextEncoder().encode(homeId), tagLength: 128,
      }, await key, bytes));
      return `v1.${base64(iv)}.${base64(ciphertext)}`;
    },
    async unwrap(homeId, wrapped) {
      const [version, iv, ciphertext, extra] = wrapped.split(".");
      if (version !== "v1" || !iv || !ciphertext || extra !== undefined) {
        throw new Error("cloud_key_invalid");
      }
      const nonce = decode(iv);
      if (nonce.length !== 12) throw new Error("cloud_key_invalid");
      return new Uint8Array(await crypto.subtle.decrypt({
        name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(homeId), tagLength: 128,
      }, await key, decode(ciphertext)));
    },
  };
}

// ---- KMS-backed wrapping (B5) --------------------------------------------------------------
import { awsKms, type Kms } from "./kms";

/** Format tags stored in cloud_home_keys.kek_id. */
export const KEK_STAGING = "v1";
export const KEK_KMS = "kms1";

interface KeyEnv {
  CLOUD_KEK_V1?: string; CLOUD_CP0_STAGING?: string;
  AWS_KMS_KEY_ARN?: string; AWS_KMS_REGION?: string; AWS_ACCESS_KEY_ID?: string; AWS_SECRET_ACCESS_KEY?: string;
}

/** Wrapper that wraps with KMS (v2 blobs) and can still read legacy v1 blobs while a rewrap is pending. */
export function kmsKeyWrapper(kms: Kms, legacy: KeyWrapper | null): KeyWrapper {
  return {
    async wrap(homeId, bytes) {
      return `v2.${base64(await kms.encrypt(bytes, { homeId }))}`;
    },
    async unwrap(homeId, wrapped) {
      if (wrapped.startsWith("v1.")) {
        if (!legacy) throw new Error("cloud_key_unavailable");
        return legacy.unwrap(homeId, wrapped);
      }
      const [version, blob, extra] = wrapped.split(".");
      if (version !== "v2" || !blob || extra !== undefined) throw new Error("cloud_key_invalid");
      return kms.decrypt(decode(blob), { homeId });
    },
  };
}

export function kmsFromEnv(env: KeyEnv, fetcher?: typeof fetch): Kms | null {
  if (!env.AWS_KMS_KEY_ARN) return null;
  if (!env.AWS_KMS_REGION || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error("cloud_key_unavailable");
  return awsKms({ keyArn: env.AWS_KMS_KEY_ARN, region: env.AWS_KMS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }, fetcher);
}

/**
 * The one place the Worker picks its key wrapper. With AWS_KMS_KEY_ARN set, new keys are KMS-wrapped
 * and the Worker-secret KEK is only a legacy reader (drop it after /v1/machines/rewrap-keys reports
 * zero remaining). Without KMS the Worker-secret KEK is used (staging only in practice; production sets AWS_KMS_KEY_ARN).
 */
export function keyWrapperFor(env: KeyEnv, fetcher?: typeof fetch): KeyWrapper {
  const kms = kmsFromEnv(env, fetcher);
  const legacy = env.CLOUD_KEK_V1 ? stagingKeyWrapper(env.CLOUD_KEK_V1) : null;
  if (kms) return kmsKeyWrapper(kms, legacy);
  if (!legacy) throw new Error("cloud_key_unavailable");
  return {
    wrap: (homeId, bytes) => legacy.wrap(homeId, bytes),
    unwrap: (homeId, wrapped) => legacy.unwrap(homeId, wrapped),
  };
}

export function kekIdFor(env: KeyEnv): string {
  return env.AWS_KMS_KEY_ARN ? KEK_KMS : KEK_STAGING;
}
/** Both formats can be read; which one is readable depends on what the Worker is configured with. */
export function kekReadable(kekId: string): boolean {
  return kekId === KEK_STAGING || kekId === KEK_KMS;
}
