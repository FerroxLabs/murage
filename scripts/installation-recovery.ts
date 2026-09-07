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
    const message = code === "VM_WORKSPACE_BACKUP_UNSUPPORTED"
      ? "Backup cannot include persistent VM workspaces yet. Stop the VM and preserve its workspace separately; browser profiles need credential-safe handling. No backup was created and original data is unchanged."
      : error instanceof Error && error.message === usage ? usage : "The recovery operation could not complete. Preserve the installation, retained copies and recovery receipts; an interrupted restore may require rollback.";
    process.stderr.write(JSON.stringify({ ok: false, error: code, ...(component ? { component } : {}), message }) + "\n");
    process.exitCode = 1;
  }
}
