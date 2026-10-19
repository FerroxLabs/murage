import { cloudHomeCopy } from "./copy.ts";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";

type SealedValue = { nonce: string; tag: string; ciphertext: string };

function bytes(value: unknown, length?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(cloudHomeCopy.invalidSealedCredentialEnvelope);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (length !== undefined && decoded.length !== length)) throw new Error(cloudHomeCopy.invalidSealedCredentialEnvelope);
  return decoded;
}

export function sealValue(plain: Buffer, key: Buffer, aad: string): SealedValue {
  if (key.length !== 32) throw new Error(cloudHomeCopy.cloudDataKeyMustBe256Bits);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function unsealValue(value: unknown, key: Buffer, aad: string): Buffer {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || key.length !== 32) throw new Error();
    const envelope = value as Record<string, unknown>;
    const decipher = createDecipheriv("aes-256-gcm", key, bytes(envelope.nonce, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(bytes(envelope.tag, 16));
    return Buffer.concat([decipher.update(bytes(envelope.ciphertext)), decipher.final()]);
  } catch { throw new Error(cloudHomeCopy.cloudCredentialEnvelopeCouldNotBeOpened); }
}

/** Only the unwrapped data key arrives on the private boot pipe. KEK stays in CP. */
export function decodeCloudBootEnvelope(raw: string, machineId: string): { bootstrapSecret: string; dataKey: Buffer } {
  let dataKey: Buffer | undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || value.version !== 2 || value.machineId !== machineId || typeof value.bootstrapSecret !== "string" || value.bootstrapSecret.length < 32
      || Object.keys(value).some(key => !["version", "machineId", "bootstrapSecret", "dataKey"].includes(key))) throw new Error();
    dataKey = bytes(value.dataKey, 32);
    return { bootstrapSecret: value.bootstrapSecret, dataKey };
  } catch {
    dataKey?.fill(0);
    throw new Error(cloudHomeCopy.cloudBootSecretsAreInvalid);
  }
}

function stringRecords(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(cloudHomeCopy.invalidCloudCredentialRecords);
  const result: Record<string, string> = Object.create(null);
  for (const [name, secret] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name) || typeof secret !== "string") throw new Error(cloudHomeCopy.invalidCloudCredentialRecords);
    result[name] = secret;
  }
  return result;
}

/** Supervisor-owned. Callers only receive copies; writes publish atomically. */
export class SealedSecretStore {
  private readonly file: string;
  private readonly key: Buffer;
  private values: Record<string, string>;
  private readonly directory: string;
  private readonly machineId: string;
  constructor(directory: string, machineId: string, dataKey: Buffer) {
    this.directory = directory;
    this.machineId = machineId;
    this.key = Buffer.from(dataKey);
    if (this.key.length !== 32) throw new Error(cloudHomeCopy.cloudDataKeyMustBe256Bits);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.assertDirectory();
    this.file = join(directory, "credentials.enc");
    this.values = Object.create(null);
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error(cloudHomeCopy.cloudCredentialFilePermissionsAreInvalid);
      const plain = unsealValue(JSON.parse(readFileSync(this.file, "utf8")), this.key, this.aad());
      try { this.values = stringRecords(JSON.parse(plain.toString("utf8"))); }
      finally { plain.fill(0); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(cloudHomeCopy.cloudCredentialStoreCouldNotBeOpened);
    }
  }
  private aad() { return `murage-cloud-credentials:v1:${this.machineId}`; }
  private assertDirectory() {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error(cloudHomeCopy.cloudCredentialDirectoryPermissionsAreInvalid);
  }
  getAll(): Record<string, string> { return { ...this.values }; }
  patch(records: Record<string, string>): Record<string, string> {
    this.assertDirectory();
    try { if (lstatSync(this.file).isSymbolicLink()) throw new Error(cloudHomeCopy.cloudCredentialFileCannotBeALink); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = { ...this.values, ...stringRecords(records) };
    const plain = Buffer.from(JSON.stringify(next));
    try { writeFileAtomic(this.file, JSON.stringify(sealValue(plain, this.key, this.aad())), { mode: 0o600 }); }
    finally { plain.fill(0); }
    this.values = next;
    return this.getAll();
  }
  close(): void { this.key.fill(0); this.values = Object.create(null); }
}
