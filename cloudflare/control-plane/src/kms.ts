// SPDX-License-Identifier: AGPL-3.0-or-later
import { signV4 } from "./aws-sigv4";

/** The only thing the Worker needs from a KMS: encrypt/decrypt small secrets bound to a context. */
export interface Kms {
  encrypt(plaintext: Uint8Array<ArrayBuffer>, context: Record<string, string>): Promise<Uint8Array<ArrayBuffer>>;
  decrypt(blob: Uint8Array<ArrayBuffer>, context: Record<string, string>): Promise<Uint8Array<ArrayBuffer>>;
}

export interface AwsKmsConfig { keyArn: string; region: string; accessKeyId: string; secretAccessKey: string; }

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** AWS KMS over SigV4. `fetcher` defaults to the global fetch, looked up per call so tests can stub it. */
export function awsKms(config: AwsKmsConfig, fetcher?: typeof fetch): Kms {
  async function call(target: "Encrypt" | "Decrypt", payload: Record<string, unknown>): Promise<Record<string, string>> {
    const body = JSON.stringify(payload);
    const url = `https://kms.${config.region}.amazonaws.com/`;
    const headers = await signV4({
      method: "POST", url, body, region: config.region, service: "kms",
      accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, now: new Date(),
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `TrentService.${target}` },
    });
    const response = await (fetcher ?? fetch)(url, { method: "POST", headers, body });
    // Never log the response body: it can carry key material on success and account detail on failure.
    if (!response.ok) throw new Error("cloud_kms_unavailable");
    return await response.json() as Record<string, string>;
  }
  return {
    async encrypt(plaintext, context) {
      const out = await call("Encrypt", { KeyId: config.keyArn, Plaintext: b64(plaintext), EncryptionContext: context });
      if (!out.CiphertextBlob) throw new Error("cloud_kms_unavailable");
      return unb64(out.CiphertextBlob);
    },
    async decrypt(blob, context) {
      const out = await call("Decrypt", { KeyId: config.keyArn, CiphertextBlob: b64(blob), EncryptionContext: context });
      // Pinned: a blob wrapped under any other key is refused even if our credentials could decrypt it.
      if (!out.Plaintext || out.KeyId !== config.keyArn) throw new Error("cloud_kms_unavailable");
      return unb64(out.Plaintext);
    },
  };
}
