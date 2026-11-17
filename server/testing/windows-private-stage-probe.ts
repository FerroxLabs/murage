// WIN-BACKUP-RT-1018: one valid private-stage request through the product's own transport to the real Windows
// backup helper, shared by the elevated test (the helper must refuse) and its standard-user control in the round
// trip file (the same request must be admitted). The only difference between the two runs is the parent's token.
//
// If the helper admits the request, the transport drives the whole protocol (PREPARED, then RELEASE plus EOF, then
// RELEASED), so the helper exits cleanly and `admitted` and `prepared` are both true.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWindowsBackupTransport } from "../installation-windows-backup-transport.ts";

export interface PrivateStageProbe {
  admitted: boolean; prepared: boolean; exitCode: number | null; toolStep: string | undefined;
  stdoutBytes: number; controlBytes: number; code: string;
}

/** Stages murage-backup-age.exe from `toolsSource` under a new temp root (pushed onto `roots` for cleanup) and sends it
 * one private-stage request. Never throws for a refusal: the caller asserts on the returned record. */
export async function probePrivateStage(toolsSource: string, roots: string[]): Promise<PrivateStageProbe> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-win-private-stage-"))); roots.push(root);
  const tools = join(root, "resources", "backup-tools", "x64"), parentDirectory = join(root, "stage-parent");
  mkdirSync(tools, { recursive: true }); mkdirSync(parentDirectory);
  copyFileSync(join(toolsSource, "murage-backup-age.exe"), join(tools, "murage-backup-age.exe"));
  let stdoutBytes = 0, controlBytes = 0, exitCode: number | null = null, prepared = false;
  const outcome = await runWindowsBackupTransport({ operation: "private-stage", parentDirectory, maxBytes: 1024 ** 2, timeoutMs: 60_000, closeTimeoutMs: 10_000,
    validate: async () => { prepared = true; return { value: "admitted" }; } }, {
    verifyHelper: async () => ({ executable: join(tools, "murage-backup-age.exe") }),
    spawn: (executable, args, options) => {
      const child = spawn(executable, args, { ...options, windowsHide: true });
      child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; });
      child.stderr.on("data", (chunk: Buffer) => { controlBytes += chunk.length; });
      child.on("close", code => { exitCode = code; });
      return child;
    },
  }).then(result => ({ admitted: true as const, result }), (error: unknown) => ({ admitted: false as const, error: error as { code?: unknown; toolDiagnostic?: { toolStep?: string; exitCode?: number } } }));
  const diagnostic = outcome.admitted ? undefined : outcome.error.toolDiagnostic;
  return { admitted: outcome.admitted, prepared, exitCode: diagnostic?.exitCode ?? exitCode, toolStep: diagnostic?.toolStep,
    stdoutBytes, controlBytes, code: outcome.admitted ? "none" : String(outcome.error.code) };
}
