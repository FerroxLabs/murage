import { installationRecoveryCommand } from "../server/installation-recovery-command.ts";
import { recoveryDesktopSummary } from "../electron/installation-recovery-protocol.mjs";
import { randomUUID } from "node:crypto";

let reply: Record<string, unknown>;
let exitCode = 0;
try {
  reply = recoveryDesktopSummary(await installationRecoveryCommand(process.argv.slice(2)));
} catch (error) {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(candidate) ? candidate : "RECOVERY_OPERATION_FAILED";
  reply = { ok: false, error: code };
  exitCode = 1;
}
const parentPort = (process as typeof process & { parentPort?: { on(event: string, listener: (event: { data?: unknown }) => void): void; postMessage(value: unknown): void } }).parentPort;
if (parentPort) {
  // Electron's stdout stream need not emit end after utility exit. Send a
  // bounded result on the private channel and wait for its exact ACK before
  // exit; the parent still requires actual exit to finish the operation.
  const nonce = randomUUID();
  const timer = setTimeout(() => process.exit(1), 10_000);
  parentPort.on("message", event => {
    const value = event.data as { type?: string; nonce?: string } | undefined;
    if (value?.type === "murage:recovery-result-ack" && value.nonce === nonce) {
      clearTimeout(timer);
      process.exit(exitCode);
    }
  });
  parentPort.postMessage({ type: "murage:recovery-result", nonce, result: reply });
} else {
  process.stdout.write(JSON.stringify(reply) + "\n", () => process.exit(exitCode));
}
