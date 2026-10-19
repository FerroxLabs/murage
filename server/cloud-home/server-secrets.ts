import { cloudHomeCopy } from "./copy.ts";
import { closeSync, readSync } from "node:fs";

/** Private supervisor-to-server boot pipe. Never materialize this in env/files. */
export interface ServerSecrets {
  version: 1;
  bootstrapSecret: string;
  credentials: Record<string, string>;
}

let boot: ServerSecrets | undefined;
const MAX_BYTES = 1_048_576;

export function readSecretPipe(fd: number): string {
  if (!Number.isSafeInteger(fd) || fd < 3) throw new Error(cloudHomeCopy.cloudSecretsPipeIsRequired);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = Buffer.alloc(8192);
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > MAX_BYTES) throw new Error(cloudHomeCopy.cloudSecretsPipeExceedsItsLimit);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function parseServerSecrets(raw: string): ServerSecrets {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || typeof record.bootstrapSecret !== "string" || record.bootstrapSecret.length < 32) throw new Error();
    if (!record.credentials || typeof record.credentials !== "object" || Array.isArray(record.credentials)) throw new Error();
    const credentials: Record<string, string> = Object.create(null);
    for (const [key, secret] of Object.entries(record.credentials)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key) || typeof secret !== "string") throw new Error();
      credentials[key] = secret;
    }
    return { version: 1, bootstrapSecret: record.bootstrapSecret, credentials };
  } catch {
    // Parsing errors must never include the payload or credential text.
    throw new Error(cloudHomeCopy.cloudSecretsPipeContainsAnInvalidEnvelope);
  }
}

export function readServerSecrets(): ServerSecrets | null {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return null;
  if (!boot) {
    const text = process.env.MURAGE_CLOUD_SECRETS_FD;
    if (!text || !/^[0-9]+$/.test(text)) throw new Error(cloudHomeCopy.cloudSecretsPipeIsRequired);
    boot = parseServerSecrets(readSecretPipe(Number(text)));
    delete process.env.MURAGE_CLOUD_SECRETS_FD;
  }
  return boot;
}

/** Only invoke after a private supervisor acknowledgement. Not an HTTP API. */
export function updateServerCredentials(values: Record<string, string>): void {
  const current = readServerSecrets();
  if (!current) throw new Error(cloudHomeCopy.cloudCredentialUpdateRequiresAHome);
  Object.assign(current.credentials, values);
}
