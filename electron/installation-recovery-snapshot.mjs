import { randomUUID } from "node:crypto";

const fail = code => Object.assign(new Error(code), { code });
const identity = value => value && typeof value === "object" && /^\d{1,20}$/.test(value.volumeSerial) && /^[a-f0-9]{32}$/.test(value.fileId);
const path = value => typeof value === "string" && /^[a-z]:\\/i.test(value) && value.length < 8192 && !/[\x00-\x1f]/.test(value);

/** Trusted-main adapter only. Renderer provides an action, never these paths.
 * The bridge binds native identities before confirm() and carries the one-shot
 * request across UAC. A complete clone still requires archive validation. */
export async function captureRecoveryCopy({ spawn, helper, source, destination, restoreJournalLeaf,
  confirm, signal, env, parentPid = process.pid, timeoutMs = 5 * 60_000 }) {
  if (!path(source) || !path(destination) || !path(helper) || typeof confirm !== "function" ||
      !/^\.murage-data-owner-[a-f0-9]{64}\.lease\.restore\.json$/.test(restoreJournalLeaf) ||
      !Number.isSafeInteger(parentPid) || parentPid < 1) throw fail("INVALID_RECOVERY_CAPTURE");
  if (signal?.aborted) throw fail("RECOVERY_CAPTURE_CANCELLED");
  const nonce = randomUUID();
  const child = spawn(helper, ["--bridge", String(parentPid)], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdin || !child.stdout) { child.kill(); throw fail("INVALID_RECOVERY_CAPTURE"); }
  let phase = "prepare", buffered = "", bytes = 0, preview = null, result = null, failure = null;
  let confirmation = Promise.resolve();
  const cancel = () => { child.stdin.end(); };
  const abort = () => { failure ??= fail("RECOVERY_CAPTURE_CANCELLED"); cancel(); };
  const invalidate = () => { failure ??= fail("INVALID_RECOVERY_CAPTURE_RESULT"); cancel(); child.kill(); };
  child.stderr?.on("data", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 64 * 1024) { invalidate(); return; }
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf("\n"); if (end < 0) break;
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message.nonce !== nonce) throw new Error();
        if (message.event === "prepared" && phase === "prepare" && identity(message.sourceIdentity) && identity(message.destinationParentIdentity) && /^S-1-\d+(?:-\d+)+$/.test(message.sid)) {
          phase = "confirm"; preview = message;
          confirmation = Promise.resolve().then(() => confirm({ source, destination, nonce,
            sourceIdentity: message.sourceIdentity, destinationParentIdentity: message.destinationParentIdentity })).then(approved => {
            if (failure || signal?.aborted || phase !== "confirm") return;
            if (!approved) { failure = fail("RECOVERY_CAPTURE_CANCELLED"); cancel(); return; }
            phase = "capture"; child.stdin.write(`CONFIRM ${nonce}\n`);
          }).catch(() => { failure = fail("RECOVERY_CAPTURE_CANCELLED"); cancel(); });
        } else if (message.event === "result" && !result && Number.isInteger(message.status) && message.status >= 0 && message.status <= 0xffffffff) {
          if (message.status === 0 && (phase !== "capture" || !preview || message.copyComplete !== true || message.snapshotReleased !== true ||
            !/^[a-f0-9-]{36}$/i.test(message.snapshotId) || /^0{8}-/.test(message.snapshotId) ||
            !identity(message.sourceIdentity) || message.sourceIdentity.fileId !== preview.sourceIdentity.fileId ||
            message.sourceIdentity.volumeSerial !== preview.sourceIdentity.volumeSerial)) throw new Error();
          result = message; phase = "result";
        } else throw new Error();
      } catch { invalidate(); }
    }
  });
  const terminal = new Promise(resolve => {
    child.once("error", () => { failure ??= fail("RECOVERY_CAPTURE_UNAVAILABLE"); resolve(-1); });
    child.once("close", code => resolve(code));
  });
  const timeout = setTimeout(() => { failure ??= fail("RECOVERY_CAPTURE_TIMEOUT"); cancel(); child.kill(); }, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  child.stdin.on("error", () => { failure ??= fail("RECOVERY_CAPTURE_UNAVAILABLE"); });
  child.stdin.write(`MURAGE_RECOVERY_1\n${nonce}\n${source}\n${destination}\n${restoreJournalLeaf}\n`);
  try {
    const exit = await terminal;
    // Do not wait indefinitely for a destroyed confirmation dialog after exit.
    phase = "closed";
    if (failure) throw failure;
    if (!result || buffered.trim()) throw fail("INVALID_RECOVERY_CAPTURE_RESULT");
    if (result.status !== 0) throw fail(result.status === 0x800704c7 ? "RECOVERY_CAPTURE_CANCELLED" : "RECOVERY_CAPTURE_FAILED");
    if (exit !== 0) throw fail("INVALID_RECOVERY_CAPTURE_RESULT");
    return { ...result, directory: destination, consistency: "crash-consistent", activationAvailable: false };
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); cancel(); void confirmation; }
}
