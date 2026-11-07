// What a restore must give back when it is NOT byte-identical (WIN-BACKUP-RT-1018).
// restoreEncryptedInstallationNew publishes the safe recovery projection: settings come back as the
// owner values with every capability off and credentials dropped, and messages.db is re-snapshotted.
// The rules below follow server/backup-restore-roundtrip.test.ts:195-208 (the product round trip).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";

type Json = Record<string, unknown>;
/** Bot fields restore rewrites to a paused, safe value (backup-restore-roundtrip.test.ts:195). */
const REWRITTEN_BOT_FIELDS = ["autoApprove", "browser", "computer", "resumeCursors"];
/** Owner config keys restore carries over unchanged. */
const KEPT_CONFIG_KEYS = ["profile", "language", "rooms", "localVm", "browserProfiles", "notifications"];
/** messages.db tables restore rewrites on purpose (observed on a real restore: memory receipts revoked, transcript index state rebuilt). */
const RESTORE_BOOKKEEPING_TABLES = ["memory_lineage_lsn_meta", "memory_lsn", "memory_meta", "memory_revoke_jobs", "transcript_index_state"];
export const CREDENTIAL_CANARY = "FAKE-CREDENTIAL-CANARY";

/** One SHA-256 per table over its rows, sorted so row order and VACUUM do not matter. */
export function tableContentHashes(dbFile: string): Record<string, string> {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const listTables = `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;
    const names = (db.prepare(listTables).all() as { name: string }[]).map(row => row.name);
    const hashes: Record<string, string> = {};
    for (const name of names) {
      const quoted = `"${name.replace(/"/g, '""')}"`;
      const rows = (db.prepare(`SELECT * FROM ${quoted}`).all() as Json[])
        .map(row => JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? `${value}n` : value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value)))
        .sort();
      hashes[name] = createHash("sha256").update(rows.join("\n")).digest("hex");
    }
    return hashes;
  } finally { db.close(); }
}

export function meaningOf(dataDir: string) {
  return {
    bots: JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as Json[],
    config: JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Json,
    tables: tableContentHashes(join(dataDir, "messages.db")),
  };
}

export function expectRestoredByMeaning(before: ReturnType<typeof meaningOf>, restoredDir: string) {
  const after = meaningOf(restoredDir);
  // bots.json: every field the owner set survives; the four safety fields come back paused.
  expect(after.bots).toHaveLength(before.bots.length);
  before.bots.forEach((bot, index) => {
    const kept = Object.fromEntries(Object.entries(bot).filter(([key]) => !REWRITTEN_BOT_FIELDS.includes(key)));
    expect(after.bots[index], `bots.json[${index}] keeps the owner values`).toMatchObject(kept);
    expect(after.bots[index], `bots.json[${index}] comes back paused`).toMatchObject({ autoApprove: false, browser: false, computer: "off", resumeCursors: {} });
  });
  // config.json: restore keeps an allowlist of owner settings (server/installation-restore-preparation.ts:216), drops
  // everything else (appearance, credentials), pins engine discovery explicit and every engine disabled.
  for (const key of KEPT_CONFIG_KEYS) if (Object.hasOwn(before.config, key)) expect(after.config[key], `config.json keeps ${key}`).toEqual(before.config[key]);
  expect(after.config.engineDiscovery, "config.json engine discovery").toBe("explicit");
  const afterInstances = (after.config.instances ?? {}) as Record<string, Json>;
  expect(Object.values(afterInstances).every(instance => instance.enabled === false), "config.json every engine disabled").toBe(true);
  expect(JSON.stringify(after.config)).not.toContain(CREDENTIAL_CANARY);
  // messages.db: every table the source held is still there; every table that is not restore bookkeeping has
  // the same rows (content hash), so nothing is dropped or altered. The bookkeeping tables are rewritten on
  // purpose (memory receipts revoked with cause=restore, transcript index rebuilt): present, not equal.
  expect(Object.keys(before.tables), "the fixture database holds the transcript table").toContain("messages");
  for (const [table, hash] of Object.entries(before.tables)) {
    expect(after.tables, `messages.db table ${table} is present`).toHaveProperty(table);
    if (!RESTORE_BOOKKEEPING_TABLES.includes(table)) expect(after.tables[table], `messages.db table ${table} content`).toBe(hash);
  }
}
