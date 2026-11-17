// Owner: sc-safety (isolated schema-copy and invalidation regressions).
import { afterEach,expect,it } from "vitest";
import { preparedInternalWritetimeFixture,initializeInternalFixtureDatabase } from "./internal-database-fixture.ts";
const fixtures:ReturnType<typeof preparedInternalWritetimeFixture>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.close();});
it("prepared internal storage copies retain full durability and independent fixture state",()=>{
  const left=preparedInternalWritetimeFixture(),right=preparedInternalWritetimeFixture();fixtures.push(left,right);
  expect(left.db.prepare("PRAGMA database_list").get()!.file).not.toBe(right.db.prepare("PRAGMA database_list").get()!.file);
  expect(left.db.prepare("SELECT installation_id FROM memory_meta").get()!.installation_id).not.toBe(right.db.prepare("SELECT installation_id FROM memory_meta").get()!.installation_id);
  expect(left.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
  expect(left.db.prepare("PRAGMA synchronous").get()!.synchronous).toBe(2);
  expect(right.db.prepare("SELECT id FROM messages ORDER BY id").all()).toEqual([{id:"X"},{id:"Y"}]);
  left.reply("T","private-copy",3);
  expect(right.db.prepare("SELECT count(*) AS n FROM messages WHERE id='private-copy'").get()!.n).toBe(0);
  expect(right.db.prepare("SELECT count(*) AS n FROM memory_open_turns").get()!.n).toBe(0);
});
it("a changed schema cookie reruns the actual internal initializer",()=>{
  const f=preparedInternalWritetimeFixture();fixtures.push(f);
  f.db.exec("DROP TABLE artifacts");
  initializeInternalFixtureDatabase(f.db);
  expect(f.db.prepare("PRAGMA table_info(artifacts)").all().map(row=>row.name)).toContain("publication_id");
  expect(f.db.prepare("SELECT count(*) AS n FROM messages").get()!.n).toBe(2);
});
