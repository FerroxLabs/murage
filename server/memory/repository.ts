import { database, transaction } from "../database.ts";

export type MemoryMode = "off" | "capture" | "active" | "paused";
export function memoryState() {
  const row = database().prepare("SELECT * FROM memory_meta WHERE id=1").get()!;
  return {installationId: String(row.installation_id), policyRevision: Number(row.policy_revision), deletionEpoch: Number(row.deletion_epoch), mode: String(row.mode) as MemoryMode};
}

/** Internal primitive; only the owner-authorized settings service may call this. */
export function setMemoryMode(mode: MemoryMode) {
  transaction(db => db.prepare("UPDATE memory_meta SET mode=? WHERE id=1").run(mode));
}
