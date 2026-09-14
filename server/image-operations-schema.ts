import type { DatabaseSync } from "node:sqlite";

/** Shared by image startup recovery and the strict installation archive schema. */
export function initializeImageOperations(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS image_operations(id TEXT PRIMARY KEY, generation TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL)");
}
