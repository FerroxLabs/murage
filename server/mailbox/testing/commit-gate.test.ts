import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

const gate = new URL("./crash-child.ts", import.meta.url).href;
const child = `
  const [module, path, side, nth] = process.argv.slice(1);
  const { runCrashChild } = await import(module);
  const plan = side === "observe" ? { observe: true } : {
    table: "fixture", where: { matches: 1 }, side, nth: Number(nth)
  };
  await runCrashChild(path, plan, {
    prepare(db) {
      db.exec("CREATE TABLE fixture(id INTEGER PRIMARY KEY, matches INTEGER); CREATE TABLE observed(count INTEGER)");
    },
    onCommit(db) {
      db.exec("INSERT INTO observed SELECT COUNT(*) FROM fixture");
    },
    run(db) {
      const insert = db.prepare("INSERT INTO fixture VALUES (?, ?)");
      db.exec("BEGIN IMMEDIATE");
      insert.run(-1, 1);
      db.exec("ROLLBACK");
      for (let id = 0; id <= 3; id++) {
        db.exec("BEGIN IMMEDIATE");
        insert.run(id, id ? 1 : 0);
        db.exec("COMMIT");
      }
    },
  });
`;

const cases = [
  ["H1 kills before the first matching commit", "before", 1, [0], []],
  ["H1b kills after the first matching commit", "after", 1, [0, 1], []],
  ["H1b counts to the third matching commit", "after", 3, [0, 1, 2, 3], []],
  ["H1 observes each committed row without killing", "observe", 0, [0, 1, 2, 3], [1, 2, 3, 4]],
] as const;

test.each(cases)("%s", (_name, side, nth, expected, observed) => {
  const directory = mkdtempSync(join(tmpdir(), "mail-commit-"));
  const path = join(directory, "fixture.db");
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", child, gate, path, side, String(nth)], {
      encoding: "utf8",
    });
    expect(result.signal, result.stderr).toBe(side === "observe" ? null : "SIGKILL");
    if (side === "observe") expect(result.status, result.stderr).toBe(0);
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare("SELECT id FROM fixture ORDER BY id").all().map(row => row.id)).toEqual(expected);
      expect(db.prepare("SELECT count FROM observed ORDER BY rowid").all().map(row => row.count)).toEqual(observed);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
