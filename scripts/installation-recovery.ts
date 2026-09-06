import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installationRecoveryCommand, usage } from "../server/installation-recovery-command.ts";
export { installationRecoveryCommand };

function invokedAsMain(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (invokedAsMain()) {
  try {
    process.stdout.write(JSON.stringify(await installationRecoveryCommand(process.argv.slice(2))) + "\n");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "RECOVERY_COMMAND_FAILED";
    const component = error && typeof error === "object" && "component" in error && ["routines.json", "calendar-calls.json", "webhooks.json", "delegation-receipts.json"].includes(String(error.component)) ? String(error.component) : undefined;
    process.stderr.write(JSON.stringify({ ok: false, error: code, ...(component ? { component } : {}), message: error instanceof Error && error.message === usage ? usage : "The recovery operation could not complete. Preserve the installation, retained copies and recovery receipts; an interrupted restore may require rollback." }) + "\n");
    process.exitCode = 1;
  }
}
