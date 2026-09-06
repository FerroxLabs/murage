import { awaitOwnedWork } from "./server-child-lifecycle.mjs";
import { recoveryDesktopSummary } from "./installation-recovery-protocol.mjs";

const fail = code => Object.assign(new Error(code), { code });
/** Keep an exact utility child tracked until exit and stdout completion.
 * Raw stderr is drained, not forwarded to the recovery UI or logs. */
export async function runInstallationRecoveryWorker({ fork, entry, args, env, track, timeoutMs = 20 * 60_000 }) {
  const child = fork(entry, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const lifecycle = track(child);
  let bytes = 0, output = "", exitCode = null, invalidOutput = false;
  let receivedPrivateResult = false;
  child.once("exit", code => { exitCode = code; });
  child.stderr?.on("data", () => {});
  const drained = new Promise(resolve => {
    child.on("message", raw => {
      const message = raw?.data ?? raw;
      if (message?.type !== "murage:recovery-result") return;
      try {
        if (receivedPrivateResult || !/^[a-f0-9-]{36}$/.test(message.nonce) || !message.result || typeof message.result !== "object") throw fail("INVALID_RECOVERY_RESULT");
        const encoded = JSON.stringify(message.result);
        if (Buffer.byteLength(encoded) > 256 * 1024) throw fail("INVALID_RECOVERY_RESULT");
        receivedPrivateResult = true;
        output = encoded;
        child.postMessage({ type: "murage:recovery-result-ack", nonce: message.nonce });
        resolve();
      } catch {
        invalidOutput = true;
        resolve();
        void lifecycle.stop().catch(() => {});
      }
    });
    if (!child.stdout) { invalidOutput = true; resolve(); return; }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 256 * 1024) {
        invalidOutput = true;
        void lifecycle.stop().catch(() => {});
      } else if (!invalidOutput && !receivedPrivateResult) output += String(chunk);
    });
    child.stdout.once("end", resolve);
    child.stdout.once("error", () => { invalidOutput = true; resolve(); });
  });
  try { await awaitOwnedWork(Promise.all([lifecycle.exit, drained]), "Recovery worker has not settled", timeoutMs); }
  catch {
    const observation = { workerExited: lifecycle.exited, outputBytes: bytes, workerExitCode: exitCode };
    await lifecycle.stop();
    throw Object.assign(fail("RECOVERY_WORKER_TIMEOUT"), observation);
  }
  if (invalidOutput || lifecycle.failed) throw fail("INVALID_RECOVERY_RESULT");
  let result;
  try { result = JSON.parse(output); } catch { throw fail("INVALID_RECOVERY_RESULT"); }
  if (exitCode !== 0 || result?.ok !== true) {
    const code = typeof result?.error === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(result.error) ? result.error : "RECOVERY_OPERATION_FAILED";
    throw fail(code);
  }
  if (result.operation !== args[0]) throw fail("INVALID_RECOVERY_RESULT");
  try { return recoveryDesktopSummary(result); } catch { throw fail("INVALID_RECOVERY_RESULT"); }
}
