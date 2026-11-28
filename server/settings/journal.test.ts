// Settings v10 J0 (owner: core): the Changed-recently journal. Real file store, real router routes. A writer missing from the
// table is refused, a retry with the same changeId is one row (also across a restart), values are recorded only where the
// writer table says so, and an absent receipt is "could not check" unless a refusal was proven.
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { JOURNAL_WRITERS, openJournal, journalFile } from "./journal.ts";
import { settingsV10Router } from "./v10-routes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const dataDir = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "journal-"))); dirs.push(dir); return dir; };
const owner = { kind: "owner" } as const;
const DAY = 86_400_000;

describe("J0 journal store", () => {
  it("refuses a writer missing from the table and every table entry names its receipt source", () => {
    const journal = openJournal(dataDir());
    expect(() => journal.write({ changeId: "c1", actor: owner, writer: "not-in-table", settingId: "x" })).toThrow(/writer/i);
    expect(() => journal.write({ changeId: "c2", actor: owner, writer: "memory.forget", settingId: "x" })).toThrow(/writer/i);
    expect(Object.keys(JOURNAL_WRITERS).length).toBeGreaterThanOrEqual(12);
    for (const [name, entry] of Object.entries(JOURNAL_WRITERS)) expect(entry.source.length, name).toBeGreaterThan(0);
  });

  it("a lost reply and a retry with the same changeId is one row, also after a restart", () => {
    const dir = dataDir();
    const first = openJournal(dir);
    first.write({ changeId: "c1", actor: owner, writer: "bot.patch", settingId: "bot.name", bot: "b1", before: "Ada", after: "Ada L" });
    const restarted = openJournal(dir);
    restarted.write({ changeId: "c1", actor: owner, writer: "bot.patch", settingId: "bot.name", bot: "b1", before: "Ada", after: "Ada L" });
    expect(restarted.list(0).rows).toHaveLength(1);
    expect(restarted.lookup("c1").state).toBe("saved");
  });

  it("pulls by cursor and an upsert keeps its place", () => {
    const journal = openJournal(dataDir());
    journal.write({ changeId: "a", actor: owner, writer: "bot.patch", settingId: "bot.name", after: "1" });
    journal.write({ changeId: "b", actor: owner, writer: "bot.patch", settingId: "bot.title", after: "2" });
    const page = journal.list(0);
    expect(page.rows.map((row) => row.changeId)).toEqual(["a", "b"]);
    journal.write({ changeId: "a", actor: owner, writer: "bot.patch", settingId: "bot.name", after: "1" });
    journal.write({ changeId: "c", actor: owner, writer: "bot.patch", settingId: "bot.section", after: "3" });
    expect(journal.list(page.cursor).rows.map((row) => row.changeId)).toEqual(["c"]);
    expect(journal.list(0).rows).toHaveLength(3);
  });

  it("records values only where the writer table says so and never a secret", () => {
    const dir = dataDir();
    const journal = openJournal(dir);
    journal.write({ changeId: "n", actor: owner, writer: "bot.patch", settingId: "bot.name", before: "Ada", after: "Ada L" });
    journal.write({ changeId: "k", actor: owner, writer: "provider.key", settingId: "provider.key", after: "sk-test-0123456789abcdef" });
    journal.write({ changeId: "p", actor: owner, writer: "bot.purpose", settingId: "bot.purpose", before: "old words", after: "new words" });
    const rows = journal.list(0).rows;
    expect(rows.find((row) => row.changeId === "n")).toMatchObject({ before: "Ada", after: "Ada L" });
    expect(rows.find((row) => row.changeId === "k")?.after).toBeUndefined();
    expect(rows.find((row) => row.changeId === "p")?.after).toBeUndefined();
    expect(readFileSync(journalFile(dir), "utf8")).not.toContain("0123456789abcdef");
  });

  it("an absent receipt is could-not-check unless a refusal was proven; rows older than 90 days are gone", () => {
    let now = 1_700_000_000_000;
    const journal = openJournal(dataDir(), () => now);
    expect(journal.lookup("never")).toEqual({ state: "couldNotCheck" });
    journal.refused("no");
    expect(journal.lookup("no")).toEqual({ state: "notSaved" });
    expect(journal.list(0).rows).toHaveLength(0);
    journal.write({ changeId: "old", actor: owner, writer: "bot.patch", settingId: "bot.name", after: "x" });
    now += 91 * DAY;
    expect(journal.lookup("old")).toEqual({ state: "couldNotCheck" });
    expect(journal.list(0).rows).toHaveLength(0);
    journal.write({ changeId: "new", actor: owner, writer: "bot.patch", settingId: "bot.name", after: "y" });
    expect(journal.list(0).rows.map((row) => row.changeId)).toEqual(["new"]);
  });

  it("keeps a script's actor as Another program", () => {
    const journal = openJournal(dataDir());
    journal.write({ changeId: "m", actor: { kind: "otherProgram" }, writer: "bot.model", settingId: "bot.model", bot: "b1", after: "model-x" });
    expect(journal.list(0).rows[0].actor).toEqual({ kind: "otherProgram" });
  });
});

describe("J0 routes", () => {
  function fixture(dir = dataDir()) {
    const router = settingsV10Router({ dataDir: dir, folderTrust: {} as never });
    async function call(method: string, path: string, body?: unknown, surface: "desktop" | "remote" = "desktop", ownersComputer?: boolean) {
      let answer: { status: number; body: any } | undefined;
      const json = (_res: ServerResponse, status: number, out: unknown) => { answer = { status, body: out }; };
      const url = new URL(`http://local${path}`);
      const handled = await router.handle({ method, path: url.pathname, url, req: {} as never, res: {} as never, json, readBody: async () => body, store: {} as never, cfg: {} as never, surface, ownersComputer });
      expect(handled).toBe(true);
      return answer!;
    }
    return { call, dir };
  }

  it("a host posts a row, the server stamps the owner as actor (never the body), and the desktop pulls and looks it up", async () => {
    const { call } = fixture();
    const post = await call("POST", "/api/settings/journal", { changeId: "h1", writer: "host.setting", settingId: "backups.schedule", actor: { kind: "bot", botId: "evil" }, after: "daily" });
    expect(post.status).toBe(200);
    const pulled = await call("GET", "/api/settings/journal?after=0");
    expect(pulled.body.rows).toHaveLength(1);
    expect(pulled.body.rows[0].actor).toEqual({ kind: "owner" });
    expect((await call("GET", "/api/settings/journal/lookup?changeId=h1")).body.state).toBe("saved");
    expect((await call("GET", "/api/settings/journal/lookup?changeId=zzz")).body.state).toBe("couldNotCheck");
  });

  it("the phone gets no journal rows and cannot write one; an unknown writer is 400 and writes nothing", async () => {
    const { call } = fixture();
    expect((await call("GET", "/api/settings/journal?after=0", undefined, "remote")).status).toBe(403);
    expect((await call("POST", "/api/settings/journal", { changeId: "p", writer: "host.setting", settingId: "x" }, "remote")).status).toBe(403);
    expect((await call("POST", "/api/settings/journal", { changeId: "u", writer: "nope", settingId: "x" })).status).toBe(400);
    expect((await call("GET", "/api/settings/journal?after=0")).body.rows).toHaveLength(0);
  });

  it("a request that is not from the owner's own computer (a Cloud phone, an owner-browser bot) is refused even on the desktop surface", async () => {
    const { call } = fixture();
    expect((await call("GET", "/api/settings/journal?after=0", undefined, "desktop", false)).status).toBe(403);
    expect((await call("POST", "/api/settings/journal", { changeId: "x", writer: "host.setting", settingId: "s" }, "desktop", false)).status).toBe(403);
    expect((await call("POST", "/api/settings/journal/refused", { changeId: "x" }, "desktop", false)).status).toBe(403);
    expect((await call("GET", "/api/settings/journal?after=0", undefined, "desktop", true)).status).toBe(200);
  });

  it("a refused host write proves Not saved", async () => {
    const { call } = fixture();
    expect((await call("POST", "/api/settings/journal/refused", { changeId: "r1" })).status).toBe(200);
    expect((await call("GET", "/api/settings/journal/lookup?changeId=r1")).body.state).toBe("notSaved");
  });
});
