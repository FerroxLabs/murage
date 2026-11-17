// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { createReadStream, statSync, constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface ClaudeS2Qualification {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly version: string;
  /** SHA256 of the pinned native CLI, not a path/mtime or a version range. */
  readonly build: string;
  /** Reviewed receipt directory in this repository. */
  readonly evidence: string;
}

/** Entries require reviewed real-CLI relist, no-cross-generation, Stop,
 * teardown and latency receipts for this exact platform/arch/version/build.
 * Offline passes and a runner's output never add entries automatically. */
export const qualifiedClaudeS2Builds: readonly ClaudeS2Qualification[] = Object.freeze([
  Object.freeze({
    platform: "linux", arch: "x64", version: "2.1.310",
    build: "b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56",
    evidence: "evidence/s2-real",
  }),
]);

export function matchesClaudeS2Qualification(
  receipts: readonly ClaudeS2Qualification[], platform: NodeJS.Platform, arch: string,
  version: string | null | undefined, build: string | null | undefined,
): boolean {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !build || !/^[a-f0-9]{64}$/.test(build)) return false;
  return receipts.some(receipt => receipt.platform === platform && receipt.arch === arch
    && receipt.version === version && receipt.build === build && receipt.evidence.trim().length > 0);
}

export function claudeS2Qualified(
  _env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  version?: string | null, build?: string | null, arch: string = process.arch,
  receipts: readonly ClaudeS2Qualification[] = qualifiedClaudeS2Builds,
): boolean {
  return matchesClaudeS2Qualification(receipts, platform, arch, version, build);
}

/** A digest belongs to all five stat values, never just a pathname/version.
 * ctime also invalidates a rewrite that restores its previous mtime/size. */
function nativeIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function fileIdentity(file: string): string | null {
  if (!isAbsolute(file)) return null;
  try { const stat = statSync(file, { bigint: true }); return stat.isFile() ? nativeIdentity(stat) : null; }
  catch { return null; }
}
interface DigestEntry {
  readonly identity: string;
  digest: string | null;
  pending: Promise<string | null>;
}
const nativeDigests = new Map<string, DigestEntry>();
const digestEpochs = new Map<string, number>();
export function invalidateClaudeS2NativeBuild(file: string): void {
  digestEpochs.set(file, (digestEpochs.get(file) ?? 0) + 1);
  nativeDigests.delete(file);
}
const MAX_NATIVE_DIGESTS = 64;

/** Only self-contained native artifacts can be qualified by this digest.
 * A shell/npm launcher can change its target without changing its own bytes;
 * it remains S1. Never execute a CLI to fingerprint it or read its config. */
export async function claudeS2NativeBuild(file: string): Promise<string | null> {
  if (!isAbsolute(file)) return null;
  try {
    const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) return null;
      const identity = nativeIdentity(before);
      const magic = Buffer.alloc(4);
      if ((await handle.read(magic, 0, 4, 0)).bytesRead !== 4) return null;
      const hex = magic.toString("hex");
      if (hex !== "7f454c46" && !hex.startsWith("4d5a")
        && !["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(hex)) return null;
      const hash = createHash("sha256");
      // Same descriptor for magic, bytes and final stat: a replacement or an
      // in-place rewrite while hashing can never publish a usable digest.
      let hashedBytes = 0n;
      for await (const chunk of createReadStream(null as never, { fd: handle.fd, autoClose: false, start: 0 })) { hash.update(chunk); hashedBytes += BigInt(chunk.length); }
      const after = await handle.stat({ bigint: true });
      if (nativeIdentity(after) !== identity || after.size !== hashedBytes || fileIdentity(file) !== identity) return null;
      return hash.digest("hex");
    } finally { await handle.close(); }
  } catch { return null; }
}

/** Engine detection can await this warm-up. Turn admission never does. */
export function prepareClaudeS2NativeBuild(file: string): Promise<string | null> {
  const identity = fileIdentity(file);
  if (!identity) { invalidateClaudeS2NativeBuild(file); return Promise.resolve(null); }
  const cached = nativeDigests.get(file);
  if (cached?.identity === identity) return cached.pending;
  invalidateClaudeS2NativeBuild(file);
  const epoch = digestEpochs.get(file);
  const entry: DigestEntry = { identity, digest: null, pending: Promise.resolve(null) };
  nativeDigests.set(file, entry);
  if (nativeDigests.size > MAX_NATIVE_DIGESTS) nativeDigests.delete(nativeDigests.keys().next().value!);
  entry.pending = claudeS2NativeBuild(file).then(digest => {
    // Invalidation/replacement wins against an older in-flight hash.
    if (digestEpochs.get(file) === epoch && nativeDigests.get(file) === entry && fileIdentity(file) === identity) entry.digest = digest;
    return entry.digest;
  });
  return entry.pending;
}

/** A miss starts a background hash and returns S1 immediately. A stat match
 * alone never admits S2: a completed digest for those exact values is needed.
 * No extra artifact I/O for identities without a matching receipt. */
export async function claudeS2QualifiedCli(
  file: string, version: string | null, env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform, arch: string = process.arch,
  receipts: readonly ClaudeS2Qualification[] = qualifiedClaudeS2Builds,
): Promise<boolean> {
  if (!receipts.some(receipt => receipt.platform === platform && receipt.arch === arch && receipt.version === version)) return false;
  const identity = fileIdentity(file);
  if (!identity) { invalidateClaudeS2NativeBuild(file); return false; }
  const cached = nativeDigests.get(file);
  if (!cached || cached.identity !== identity) {
    void prepareClaudeS2NativeBuild(file);
    return false;
  }
  return claudeS2Qualified(env, platform, version, cached.digest, arch, receipts);
}

/** Last synchronous check before reuse/spawn. The remaining stat-to-exec window
 * is not code signing; qualification controls only retained-session behavior. */
export function claudeS2QualifiedCliNow(
  file: string, version: string | null, env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform, arch: string = process.arch,
  receipts: readonly ClaudeS2Qualification[] = qualifiedClaudeS2Builds,
): boolean {
  const entry = nativeDigests.get(file), identity = fileIdentity(file);
  if (!identity || !entry || entry.identity !== identity || !entry.digest) {
    invalidateClaudeS2NativeBuild(file);
    return false;
  }
  return claudeS2Qualified(env, platform, version, entry.digest, arch, receipts);
}
