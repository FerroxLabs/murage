import type { DatabaseSync } from "node:sqlite";

/** Shared by image startup recovery and the strict installation archive schema. */
export function initializeImageOperations(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS image_operations(id TEXT PRIMARY KEY, generation TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL)");
}

/** Saved prompt blocks and reference packs (versioned; `bot_id` is '' in the
 * workspace scope so the version key stays unique), the prompt each approved
 * render was sent, and each model's last check. Shared with the installation
 * archive schema like image_operations. */
export function initializeImageLibrary(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS image_prompt_blocks(id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('workspace','bot')), bot_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, chars INTEGER NOT NULL, sha256 TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER, UNIQUE(scope, bot_id, name, version));
    CREATE TABLE IF NOT EXISTS image_render_prompts(operation_id TEXT PRIMARY KEY, prompt TEXT NOT NULL, blocks TEXT NOT NULL, prompt_chars INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS image_reference_packs(id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('workspace','bot')), bot_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, images TEXT NOT NULL, count INTEGER NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER, UNIQUE(scope, bot_id, name, version));
    CREATE TABLE IF NOT EXISTS image_model_probes(connection_id TEXT NOT NULL, model TEXT NOT NULL, last_probe_at INTEGER NOT NULL, ok INTEGER NOT NULL, last_good_at INTEGER, last_failed_at INTEGER, error_code TEXT, error_message TEXT, duration_ms INTEGER, cost_usd REAL, PRIMARY KEY(connection_id, model));`);
}
