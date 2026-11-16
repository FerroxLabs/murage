// Owners: composio-429-e owns hold persistence and the lifecycle load barrier.
import { openSync, readFileSync, renameSync, unlinkSync, mkdirSync, fsyncSync, closeSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPOSIO_ADMISSION_FILE as ADMISSION_FILE } from "./composio-release-config.mjs";
import { randomUUID } from "node:crypto";

export function createComposioAdmissionStore(dataDir) {
  const file = join(dataDir, ADMISSION_FILE);
  return Object.freeze({
    load() {
      let text;
      try { text = readFileSync(file, "utf8"); }
      catch (error) { if (error?.code === "ENOENT") return []; throw error; }
      const doc = JSON.parse(text);
      if (doc?.version !== 1 || !Array.isArray(doc.holds) || doc.holds.length > 256) throw new Error("admission_storage_invalid");
      for (const row of doc.holds) {
        if (!row || !/^[a-f0-9]{64}$/.test(row.scope) || !Number.isFinite(row.notBefore) || row.notBefore < 0
          || !Number.isSafeInteger(row.failureStreak) || row.failureStreak < 0 || !Number.isSafeInteger(row.generation)
          || !Number.isInteger(row.status)) throw new Error("admission_storage_invalid");
      }
      return doc.holds;
    },
    save(holds) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      let fd;
      try {
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, JSON.stringify({ version: 1, holds }));
        fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, file);
        const directory = openSync(dirname(file), "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    },
  });
}
