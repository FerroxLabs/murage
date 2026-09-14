import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import * as wire from "../native/backup-age/protocol.mjs";
import { win32 } from "node:path";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { backupIdentity, stopBackupAgeProcess } from "./installation-backup-encryption.ts";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";

export interface WindowsBackupChild extends Pick<EventEmitter, "on" | "once" | "off"> {
  stdin: Writable; stdout: Readable; stderr: Readable; pid?: number;
  kill(signal: NodeJS.Signals): unknown;
  unref(): void;
}
export interface WindowsBackupDependencies {
  /** Trusted host verifies the fixed installed adapter resource; no default or renderer path. */
  verifyHelper(): Promise<{ executable: string }>;
  spawn(executable: string, args: string[], options: {
    stdio: ["pipe", "pipe", "pipe"]; env: { PATH: string }; windowsHide: true;
  }): WindowsBackupChild;
  /** Test seam only: returns a real exclusive writable fd. Production uses wx below. */
  openExclusiveOutput?: (path: string) => number;
}
export interface WindowsBackupIdentity { volumeSerial: string; fileId: string }
export interface WindowsBackupContext {
  directory: string;
  plaintext?: string;
  sourceIdentity: WindowsBackupIdentity;
  sourceBytes: number;
  stageIdentity: WindowsBackupIdentity;
  signal: AbortSignal;
}
export interface WindowsBackupRequest<T> {
  operation: "decrypt" | "private-stage";
  parentDirectory: string;
  ciphertext?: string;
  identity?: string;
  maxBytes: number;
  timeoutMs?: number;
  closeTimeoutMs?: number;
  signal?: AbortSignal;
  /** Complete all stage writers before returning; validation runs while guards are held.
   * Decrypt must hash its ciphertext during this callback for the final native receipt. */
  validate(context: WindowsBackupContext): Promise<{ value: T; ciphertextSha256?: string }>;
}
const error = (code: string) => new InstallationSnapshotError(code);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function send(stream: Writable, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => stream.write(data, cause => cause ? reject(error("AGE_PROCESS_FAILED")) : resolve()));
}

/** Source-only trusted-host adapter; deliberately not connected to platform admission. */
export async function runWindowsBackupTransport<T>(request: WindowsBackupRequest<T>, dependencies: WindowsBackupDependencies) {
  const nonce = randomUUID(), timeoutMs = request.timeoutMs ?? 900000, closeTimeoutMs = request.closeTimeoutMs ?? 5000;
  const encoded = wire.encodeRequest({ nonce, operation: request.operation, parentPid: process.pid,
    parentDirectory: request.parentDirectory, ciphertext: request.ciphertext ?? "", maxBytes: request.maxBytes, timeoutMs, closeTimeoutMs },
  request.operation === "decrypt" ? backupIdentity(request.identity ?? "") : request.identity ?? "");
  const directory = win32.join(request.parentDirectory, `.murage-backup-${nonce}`);
  const plaintext = request.operation === "decrypt" ? win32.join(directory, "authenticated.zip") : undefined;
  const protocol = wire.createControlProtocol(nonce, request.operation, request.maxBytes);
  const prepared = deferred<WindowsBackupContext>(), outputReady = deferred<void>(), released = deferred<string>(), closed = deferred<number | null>();
  const validationAbort = new AbortController();
  let rejectFailure!: (failure: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject; }); void failed.catch(() => {});
  let failure: Error | undefined, child: WindowsBackupChild | undefined, didClose = false, fd: number | undefined;
  const fail = (code = "AGE_PROCESS_FAILED") => {
    if (failure) return;
    failure = error(code); validationAbort.abort(); rejectFailure(failure);
  };
  const step = <V>(promise: Promise<V>): Promise<V> => Promise.race([promise, failed]);
  const onAbort = () => fail("SNAPSHOT_CANCELLED");
  const onError = () => fail();
  const onClose = (code: number | null) => {
    didClose = true; closed.resolve(code);
    if (protocol.state !== "released" || code !== 0) fail();
  };
  const onData = (chunk: Buffer) => {
    if (failure) return;
    try {
      if (!Buffer.isBuffer(chunk) || fd === undefined) throw error("AGE_PROCESS_FAILED");
      protocol.plaintext(chunk.length);
      let offset = 0;
      while (offset < chunk.length) { const written = writeSync(fd, chunk, offset, chunk.length - offset); if (written <= 0) throw error("AGE_PROCESS_FAILED"); offset += written; }
      if (protocol.plaintextComplete) outputReady.resolve();
    } catch { fail(); }
  };
  const onControl = (chunk: Buffer) => {
    if (failure) return;
    try {
      for (const message of protocol.receive(chunk)) {
        if (message.event === "PREPARED") {
          const [volumeSerial, fileId, size, stageVolume, stageId] = message.fields;
          if (stageVolume === "0" || /^0+$/.test(stageId) || Number(size) > request.maxBytes ||
              (request.operation === "decrypt" ? Number(size) < 1 || volumeSerial === "0" || /^0+$/.test(fileId) : size !== "0" || volumeSerial !== "0" || !/^0+$/.test(fileId))) throw error("AGE_PROCESS_FAILED");
          prepared.resolve({ directory, plaintext, sourceIdentity: { volumeSerial, fileId }, sourceBytes: Number(size),
            stageIdentity: { volumeSerial: stageVolume, fileId: stageId }, signal: validationAbort.signal });
        } else if (message.event === "CHILD_CLOSED" && protocol.plaintextComplete) outputReady.resolve();
        else if (message.event === "RELEASED") released.resolve(message.fields[0]);
      }
    } catch { fail(); }
  };
  let timer = setTimeout(() => fail("AGE_TOOL_TIMEOUT"), 30000);
  request.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (request.signal?.aborted) onAbort();
    const resource = await step(dependencies.verifyHelper());
    if (!wire.safePath(resource.executable) || !/\\backup-tools\\x64\\murage-backup-age\.exe$/i.test(resource.executable)) throw error("AGE_TOOL_UNVERIFIED");
    if (failure) throw failure;
    child = dependencies.spawn(resource.executable, ["--parent", String(process.pid)], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "" }, windowsHide: true });
    if (!child.stdin || !child.stdout || !child.stderr) throw error("AGE_PROCESS_FAILED");
    child.on("error", onError); child.on("close", onClose);
    child.stdin.on("error", onError); child.stdout.on("error", onError); child.stderr.on("error", onError);
    child.stdout.on("data", onData); child.stderr.on("data", onControl);
    await step(send(child.stdin, encoded.header));
    try { if (encoded.key.length) await step(send(child.stdin, encoded.key)); } finally { encoded.key.fill(0); }
    const context = await step(prepared.promise);
    if (failure) throw failure;
    clearTimeout(timer); timer = setTimeout(() => fail("AGE_TOOL_TIMEOUT"), timeoutMs);
    if (plaintext) {
      fd = (dependencies.openExclusiveOutput ?? (path => openSync(path, "wx", 0o600)))(plaintext);
      await step(send(child.stdin, protocol.command("START")));
      // Status can arrive before stdout; the exact native byte count is the barrier.
      // Never await helper stdout EOF here: the helper keeps it open until RELEASE.
      await step(outputReady.promise);
      fsyncSync(fd); closeSync(fd); fd = undefined;
    }
    const validated = await step(Promise.resolve().then(() => request.validate(context)));
    if (request.operation === "decrypt" && !/^[a-f0-9]{64}$/.test(validated.ciphertextSha256 ?? "")) throw error("ARCHIVE_HASH_REQUIRED");
    if (failure) throw failure;
    const release = protocol.command("RELEASE");
    child.stdin.end(release); // Native requires actual EOF immediately after RELEASE.
    const digest = await step(released.promise);
    if (request.operation === "decrypt" && digest !== validated.ciphertextSha256) throw error("ARCHIVE_HASH_CHANGED");
    const code = await step(closed.promise); protocol.close(code);
    return { value: validated.value, directory, plaintext, ciphertextSha256: request.operation === "decrypt" ? digest : undefined,
      guardsClosed: true as const, helperClosed: true as const };
  } catch (cause) {
    validationAbort.abort();
    let confirmed = !child;
    if (child) {
      try { child.stdin.end(protocol.command("CANCEL")); } catch { child.stdin.destroy(); }
      confirmed = await stopBackupAgeProcess(child, () => didClose, closed.promise, closeTimeoutMs);
      if (!confirmed) child.unref();
    }
    const caught = cause instanceof InstallationSnapshotError ? cause : error("AGE_PROCESS_FAILED");
    throw Object.assign(confirmed ? caught : error("AGE_PROCESS_CLOSE_UNCONFIRMED"), { retainedDirectory: directory, helperClosed: confirmed });
  } finally {
    clearTimeout(timer); request.signal?.removeEventListener("abort", onAbort); encoded.key.fill(0);
    if (fd !== undefined) closeSync(fd);
    if (child) {
      // Owned streams/process may still deliver a queued error after teardown.
      child.on("error", () => {}); child.stdin.on("error", () => {}); child.stdout.on("error", () => {}); child.stderr.on("error", () => {});
      child.off("error", onError); child.off("close", onClose);
      child.stdin.off("error", onError); child.stdout.off("error", onError); child.stderr.off("error", onError);
      child.stdout.off("data", onData); child.stderr.off("data", onControl);
      // Streams are owned by this invocation. Destruction does not establish process close.
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  }
}
