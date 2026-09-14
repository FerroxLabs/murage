import { EventEmitter } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { runWindowsBackupTransport, type WindowsBackupChild, type WindowsBackupRequest } from "./installation-windows-backup-transport.ts";

const identity = `AGE-SECRET-KEY-1${"A".repeat(58)}\n`, digest = "c".repeat(64);
const helper = "C:\\Installed\\resources\\backup-tools\\x64\\murage-backup-age.exe";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
interface Mode {
  unknownClose?: boolean; neverOutput?: boolean; earlyClose?: boolean; wrongNonce?: boolean; wrongDigest?: boolean;
  overflow?: boolean; malformed?: boolean; beforePrepared?: boolean; duplicate?: boolean;
}
function fixture(mode: Mode = {}) {
  const root = mkdtempSync(join(tmpdir(), "murage-windows-transport-fake-test-")); roots.push(root);
  const stage = join(root, "stage"), output = join(stage, "authenticated.zip");
  const writes: Buffer[] = [], commands: string[] = [], calls: unknown[][] = [];
  let keyWrite: Buffer | undefined, nonce = "", operation = "", input = Buffer.alloc(0), headerLength: number | undefined, metadataLength = 0, keyLength = 0, requestedRelease = false;
  let instance: Fake | undefined;
  class Fake extends EventEmitter implements WindowsBackupChild {
    stdout = new PassThrough(); stderr = new PassThrough(); pid = 99999; signals: NodeJS.Signals[] = []; unreferenced = false;
    stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        writes.push(Buffer.from(chunk));
        if (!nonce) {
          input = Buffer.concat([input, chunk]);
          if (headerLength === undefined) {
            const newline = input.indexOf(10);
            if (newline >= 0) { metadataLength = Number(input.subarray(0, newline).toString()); headerLength = newline + 1; }
          }
          if (headerLength !== undefined && input.length >= headerLength + metadataLength) {
            const fields = input.subarray(headerLength, headerLength + metadataLength).toString().split("\n");
            keyLength = Number(fields[6]);
            if (input.length === headerLength + metadataLength + keyLength) {
              nonce = fields[1]; operation = fields[2];
              if (keyLength) { keyWrite = chunk; expect(input.subarray(headerLength + metadataLength).toString()).toBe(identity); }
              mkdirSync(stage, { mode: 0o700 });
              queueMicrotask(() => {
                if (mode.beforePrepared) this.stdout.write("unexpected plaintext");
                const prepared = ["PREPARED", operation === "decrypt" ? "123" : "0", (operation === "decrypt" ? "a" : "0").repeat(32), operation === "decrypt" ? "10" : "0", "123", "b".repeat(32)];
                this.control(...prepared);
                if (mode.duplicate) this.control(...prepared);
              });
            }
          }
        } else {
          const command = chunk.toString(); commands.push(command);
          if (command.endsWith("\tSTART\n")) {
            if (mode.earlyClose) queueMicrotask(() => this.emit("close", 0));
            else if (mode.malformed) queueMicrotask(() => this.stderr.write("AGE-SECRET-KEY-invalid diagnostic\n"));
            else {
              queueMicrotask(() => this.control("CHILD_CLOSED", "0", "5"));
              if (!mode.neverOutput) setImmediate(() => {
                if (!this.stdout.destroyed) this.stdout.write(mode.overflow ? "TOO-LONG" : "hello");
              });
            }
          } else if (command.endsWith("\tRELEASE\n")) requestedRelease = true;
        }
        callback();
      },
      final: callback => {
        if (requestedRelease) queueMicrotask(() => {
          this.control("RELEASED", operation === "decrypt" ? (mode.wrongDigest ? "d".repeat(64) : digest) : "-");
          if (!mode.unknownClose) { this.stdout.end(); this.stderr.end(); this.emit("close", 0); }
        });
        callback();
      },
    });
    control(...fields: string[]) { this.stderr.write(["1", mode.wrongNonce ? "f".repeat(36) : nonce, ...fields].join("\t") + "\n"); }
    kill(signal: NodeJS.Signals) { this.signals.push(signal); if (!mode.unknownClose) queueMicrotask(() => this.emit("close", 72)); return true; }
    unref() { this.unreferenced = true; }
  }
  const dependencies = {
    verifyHelper: async () => ({ executable: helper }),
    spawn: (executable: string, args: string[], options: unknown) => { calls.push([executable, args, options]); instance = new Fake(); return instance; },
    openExclusiveOutput: (path: string) => {
      expect(path).toBe(win32.join("C:\\Approved", `.murage-backup-${nonce}`, "authenticated.zip"));
      expect(existsSync(stage)).toBe(true); return openSync(output, "wx", 0o600);
    },
  };
  const request: WindowsBackupRequest<string> = {
    operation: "decrypt", parentDirectory: "C:\\Approved", ciphertext: "C:\\Approved\\cipher.age", identity,
    maxBytes: 1024, timeoutMs: 1000, closeTimeoutMs: 5,
    validate: async context => {
      expect(readFileSync(output, "utf8")).toBe("hello");
      expect(instance!.stdout.readableEnded).toBe(false);
      expect(commands.some(command => command.includes("RELEASE"))).toBe(false);
      expect(context.sourceBytes).toBe(10); expect(context.stageIdentity.fileId).toBe("b".repeat(32));
      return { value: "validated", ciphertextSha256: digest };
    },
  };
  return { root, stage, output, request, dependencies, writes, commands, calls, get child() { return instance!; }, get keyWrite() { return keyWrite; } };
}

it("waits for delayed stdout count, flushes exclusive output, validates under guards and requires release plus close", async () => {
  const f = fixture(); const result = await runWindowsBackupTransport(f.request, f.dependencies);
  expect(result).toMatchObject({ value: "validated", ciphertextSha256: digest, guardsClosed: true, helperClosed: true });
  expect(readFileSync(f.output, "utf8")).toBe("hello");
  expect(f.commands.map(command => command.split("\t")[2].trim())).toEqual(["START", "RELEASE"]);
  expect(f.child.stdin.writableEnded).toBe(true); expect(f.keyWrite?.every(byte => byte === 0)).toBe(true);
  expect(f.writes.filter(write => write.toString() === identity)).toHaveLength(1);
  expect(JSON.stringify(f.calls)).not.toContain(identity);
  expect(f.calls).toEqual([[helper, ["--parent", String(process.pid)], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "" }, windowsHide: true }]]);
});

it("private-stage validates and finishes its writers while held without opening plaintext or starting age", async () => {
  const f = fixture(); let opened = false;
  const result = await runWindowsBackupTransport({ ...f.request, operation: "private-stage", ciphertext: undefined, identity: undefined,
    validate: async context => { expect(context.plaintext).toBeUndefined(); writeFileSync(join(f.stage, "owned.txt"), "stage-data"); return { value: "staged" }; } },
  { ...f.dependencies, openExclusiveOutput: () => { opened = true; throw new Error("unexpected"); } });
  expect(result.value).toBe("staged"); expect(opened).toBe(false); expect(f.keyWrite).toBeUndefined();
  expect(f.commands.map(command => command.split("\t")[2].trim())).toEqual(["RELEASE"]);
  expect(readFileSync(join(f.stage, "owned.txt"), "utf8")).toBe("stage-data");
});

it("rejects an unverified or wrong fixed helper before spawn", async () => {
  const f = fixture();
  await expect(runWindowsBackupTransport(f.request, { ...f.dependencies, verifyHelper: async () => ({ executable: "C:\\other.exe" }) })).rejects.toMatchObject({ code: "AGE_TOOL_UNVERIFIED" });
  await expect(runWindowsBackupTransport(f.request, { ...f.dependencies, verifyHelper: async () => { throw new Error("private verification detail"); } })).rejects.toMatchObject({ code: "AGE_PROCESS_FAILED" });
  expect(f.calls).toHaveLength(0); expect(existsSync(f.stage)).toBe(false);
});

it.each([{ wrongNonce: true }, { malformed: true }, { beforePrepared: true }, { overflow: true }, { duplicate: true }, { earlyClose: true }])("fails closed and retains the stage for protocol failure %j", async mode => {
  const f = fixture(mode); let validated = false;
  await expect(runWindowsBackupTransport({ ...f.request, validate: async () => { validated = true; return { value: "bad", ciphertextSha256: digest }; } }, f.dependencies)).rejects.toMatchObject({ code: "AGE_PROCESS_FAILED", retainedDirectory: expect.stringContaining(".murage-backup-") });
  expect(validated).toBe(false); expect(existsSync(f.stage)).toBe(true);
  expect(f.commands.some(command => command.includes("RELEASE"))).toBe(false);
});

it("refuses existing output without truncation or age start", async () => {
  const f = fixture();
  await expect(runWindowsBackupTransport(f.request, { ...f.dependencies, openExclusiveOutput: () => { writeFileSync(f.output, "original"); return openSync(f.output, "wx"); } })).rejects.toMatchObject({ code: "AGE_PROCESS_FAILED" });
  expect(readFileSync(f.output, "utf8")).toBe("original"); expect(f.commands.some(command => command.includes("START"))).toBe(false);
});

it("retains authenticated plaintext if held-guard validation rejects", async () => {
  const f = fixture();
  await expect(runWindowsBackupTransport({ ...f.request, validate: async () => { throw new Error("private archive detail"); } }, f.dependencies)).rejects.toMatchObject({ code: "AGE_PROCESS_FAILED", retainedDirectory: expect.any(String) });
  expect(readFileSync(f.output, "utf8")).toBe("hello"); expect(f.commands.some(command => command.includes("RELEASE"))).toBe(false);
});

it("requires matching ciphertext receipt even after helper close", async () => {
  const f = fixture({ wrongDigest: true });
  await expect(runWindowsBackupTransport(f.request, f.dependencies)).rejects.toMatchObject({ code: "ARCHIVE_HASH_CHANGED", retainedDirectory: expect.any(String) });
  expect(existsSync(f.output)).toBe(true);
});

it("times out missing stdout and retains scratch with no validation or release", async () => {
  const f = fixture({ neverOutput: true });
  await expect(runWindowsBackupTransport({ ...f.request, timeoutMs: 20 }, f.dependencies)).rejects.toMatchObject({ code: "AGE_TOOL_TIMEOUT", helperClosed: true });
  expect(existsSync(f.output)).toBe(true); expect(f.commands.some(command => command.includes("RELEASE"))).toBe(false);
});

it("cancellation propagates to held validation and never claims successful cleanup", async () => {
  const f = fixture(); const abort = new AbortController(); let validationSignal: AbortSignal | undefined;
  await expect(runWindowsBackupTransport({ ...f.request, signal: abort.signal, validate: async context => {
    validationSignal = context.signal; abort.abort(); return { value: "cancelled", ciphertextSha256: digest };
  } }, f.dependencies)).rejects.toMatchObject({ code: "SNAPSHOT_CANCELLED" });
  expect(validationSignal?.aborted).toBe(true); expect(existsSync(f.output)).toBe(true);
});

it("RELEASED without actual helper close cannot succeed and retains the stage", async () => {
  const f = fixture({ unknownClose: true });
  await expect(runWindowsBackupTransport({ ...f.request, timeoutMs: 20 }, f.dependencies)).rejects.toMatchObject({ code: "AGE_PROCESS_CLOSE_UNCONFIRMED", helperClosed: false });
  expect(f.child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(f.child.unreferenced).toBe(true); expect(existsSync(f.output)).toBe(true);
});

it("pre-cancelled requests never spawn or consume identity", async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort();
  await expect(runWindowsBackupTransport({ ...f.request, signal: abort.signal }, f.dependencies)).rejects.toMatchObject({ code: "SNAPSHOT_CANCELLED" });
  expect(f.calls).toHaveLength(0);
});

it("output fd is closed before validation begins", async () => {
  const f = fixture(); let fd = -1;
  await runWindowsBackupTransport({ ...f.request, validate: async () => {
    expect(() => closeSync(fd)).toThrow(); return { value: "closed", ciphertextSha256: digest };
  } }, { ...f.dependencies, openExclusiveOutput: path => { fd = f.dependencies.openExclusiveOutput(path); return fd; } });
});
