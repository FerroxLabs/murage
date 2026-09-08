import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema, validateMemorySchema } from "./schema.ts";

describe("memory activation compatibility", () => {
  it("allows a new installation to start with local capture and recall", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateMemorySchema(db, "active");
      expect(db.prepare("SELECT mode FROM memory_meta").get()?.mode).toBe("active");
      expect(db.prepare("SELECT count(*) AS count FROM memory_scope_bindings").get()?.count).toBe(0);
      expect(() => validateMemorySchema(db)).not.toThrow();
    } finally { db.close(); }
  });
  it.each(["off", "capture", "paused", "active"])("preserves existing %s instead of silently activating on upgrade", mode => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateMemorySchema(db, "off");
      db.prepare("UPDATE memory_meta SET mode=?").run(mode);
      const before = db.prepare("SELECT * FROM memory_meta").get();
      migrateMemorySchema(db, "active");
      expect(db.prepare("SELECT * FROM memory_meta").get()).toEqual(before);
    } finally { db.close(); }
  });
  it("keeps an existing pre-memory database off pending owner activation", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateMemorySchema(db);
      expect(db.prepare("SELECT mode FROM memory_meta").get()?.mode).toBe("off");
    } finally { db.close(); }
  });
});
