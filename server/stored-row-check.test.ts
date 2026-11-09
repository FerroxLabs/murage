// U4 S3: the one stored-row check (server/stored-row-check.ts), and the pin that keeps every reader of the messages json column on
// the one decoder (rowToMessage) and every writer on the one encoder (storedJson).
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkStoredRow } from "./stored-row-check.ts";
import type { Message } from "./store.ts";

const SECRET = () => `use ${"AKIA"}${"ABCDEFGHIJKLMNOP"} to upload`; // secret-scan: fixture
const TURN = "6f1d1c2e-1b6a-4f3e-9a51-2d1f3c4b5a69";
const diagnostic = { version: 1, diagnosticId: "ev-a1-b2", turnId: TURN } as const;

describe("checkStoredRow", () => {
  it("keeps a good done-when line, folds brackets, drops a secret-shaped, over-long or non-text one", () => {
    const row = (doneWhen: unknown) => ({ role: "bot", kind: "activity", tool: { name: "Delegated to @Helper", doneWhen } }) as unknown as Message;
    expect(checkStoredRow(row("the PR is open")).tool?.doneWhen).toBe("the PR is open");
    expect(checkStoredRow(row("a]b")).tool?.doneWhen).toBe("a)b");
    for (const bad of [SECRET(), "x".repeat(281), 42, "   "]) {
      const checked = checkStoredRow(row(bad));
      expect(checked.tool && "doneWhen" in checked.tool).toBe(false);
      expect(checked.tool?.name).toBe("Delegated to @Helper");
    }
  });
  it("keeps a diagnostic only on its own turn's bot activity row, in its bounded shape", () => {
    const base = { role: "bot", kind: "activity", turnId: TURN, tool: { name: "error", diagnostic } } as unknown as Message;
    expect(checkStoredRow(base).tool?.diagnostic).toEqual(diagnostic);
    expect(checkStoredRow({ ...base, turnId: "other" }).tool?.diagnostic).toBeUndefined();
    expect(checkStoredRow({ ...base, role: "user" }).tool?.diagnostic).toBeUndefined();
    expect(checkStoredRow({ ...base, tool: { name: "error", diagnostic: { ...diagnostic, extra: SECRET() } } } as unknown as Message).tool?.diagnostic).toBeUndefined();
  });
  it("is idempotent, returns an untouched row as is, and never edits its input", () => {
    const plain = { role: "bot", kind: "text", text: "hi" } as Message;
    expect(checkStoredRow(plain)).toBe(plain);
    const input = { role: "bot", kind: "activity", tool: { name: "x", doneWhen: SECRET() } } as Message;
    const once = checkStoredRow(input);
    expect(checkStoredRow(once)).toEqual(once);
    expect(input.tool?.doneWhen).toBe(SECRET());
    expect(checkStoredRow(null as unknown as Message)).toBe(null);
  });
});

// The pin, per call site: every SQL statement in non-test server code that selects the messages json column, or writes it, is in a file
// that decodes with rowToMessage (and, for a write, encodes with storedJson), or is listed here with its reason. Statements are matched
// over the whole file, so one split across lines or built from a template is caught too. No JSON.parse of a json column value is left
// in any server file outside transcript-seq.ts. A new unlisted reader fails here.
describe("every reader of the messages json column uses the one decoder", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  /** One SELECT up to the messages table it reads (FROM or JOIN), with no other SELECT in between. */
  const STATEMENT = /\bSELECT\b((?:(?!\bSELECT\b)[\s\S]){0,800}?)\b(?:FROM|JOIN)\s+messages\b/g;
  /** A json column in that select list; one inside json_extract(json, ...), length(json) or instr(json, ...) only reads a field or a size. */
  const COLUMN = /\b(?:\w+\.)?json\b(?![\w(])/g;
  const FIELD_ONLY = /(?:json_\w+|octet_length|length|instr)\(\s*(?:\w+\.)?$/;
  const WRITE = /messages\s+SET\s+json\b/g;
  const PARSE = /JSON\.parse\(\s*(?:String\()?\s*[\w!.]*\.json\b/g;
  const DECODES = new Set([
    "server/message-db.ts", "server/transcript-backfill.ts", "server/bot-read.ts", "server/partition-sources.ts", "server/working-context.ts",
    "server/project-memory-tools.ts", "server/installation-restore-preparation.ts", "server/inbox.ts", "server/mcp-signin-card.ts",
    "server/memory/reveal-capture.ts", "server/project-goals.ts", "server/installation-database-snapshot.ts", "server/installation-activation.ts",
    "server/memory/outcomes.ts", "server/memory/lineage-backfill.ts", "server/harness/event-log.ts", "server/murage-anchor.ts",
    "server/memory/capture.ts", "server/message-walker.ts", "server/bot-calls-machine.ts",
  ]);
  /** Writers that encode a whole row: storedJson. */
  const ENCODES = new Set(["server/message-db.ts", "server/installation-restore-preparation.ts"]);
  /** file + a substring of the statement (SELECT through the end of its FROM line) or of the write's line: the reason it may read or
   *  write the column without the decoder. */
  const ALLOW: Array<[string, string, string]> = [
    ["server/conversation-deletion.ts", "SELECT json FROM messages WHERE thread_id IN", "scans the raw text for attachment file names; never decodes or shows a row"],
    ["server/transcript-backfill.ts", "SELECT rowid AS mrow, thread_id, id, json FROM messages WHERE rowid > ? AND rowid <= ? ORDER BY rowid", "attachment-name index walk: a regex over the raw text, never decoded (iterated, with the row position for the time-bounded chunk)"],
    ["server/branch-index.ts", "THEN json END AS body", "hands the row to branch-fill.ts, which decodes it with rowToMessage"],
    ["server/installation-database-snapshot.ts", "UPDATE messages SET json=json_set(json, '$.card.subtitle'", "SQL json_set of card text fields on restore; never touches tool"],
    ["server/memory/lineage-backfill.ts", "UPDATE messages SET json=json_set(json,'$.withheldFromBots'", "SQL json_set of the withheld flag; never touches tool"],
    ["server/memory/deny-read.ts", "m.json AS anchor_json", "hands the anchor row's json to murageAnchorOf (murage-anchor.ts), which decodes it with rowToMessage"],
    ["server/memory/lineage-warm.ts", "SELECT id, text, json FROM messages WHERE thread_id=? AND rowid>?", "the clean confirm reads one row's parentId only (anchorAdjacent); nothing is shown, decoded or kept"],
    ["server/memory/lineage-warm-surface.ts", "SELECT id, role, kind, text, at, json FROM messages WHERE thread_id=? AND kind='text'", "test-only seam (no production caller): fixture rows of the test database"],
    ["server/memory/lineage-warm-surface.ts", "SELECT text, json FROM messages WHERE thread_id=? AND id=?", "test-only seam (no production caller): copies a fixture row's own json"],
    ["server/inbox.base-reference.ts", "json FROM messages", "frozen 1.0.2 oracle for inbox.base-equivalence.test.ts; not on a serving path"],
    ["server/testing/index-harness.ts", "substr(json, 1, 300) AS json FROM messages", "test harness diagnostic print"],
  ];
  /** Frozen copies of an older inbox.ts, kept only as test oracles; never on a serving path. */
  const PARSE_ALLOW = new Set(["server/inbox.base-reference.ts", "server/inbox.legacy-reference.ts", "server/memory/lineage-warm-surface.ts" /* test-only seam, no production caller */]);
  const files = globSync("server/**/*.ts", { cwd: ROOT }).map((f) => f.split("\\").join("/")).filter((f) => !f.endsWith(".test.ts")).sort();
  const lineAt = (source: string, index: number) => source.slice(0, index).split("\n").length;
  const lineEnd = (source: string, index: number) => { const end = source.indexOf("\n", index); return end < 0 ? source.length : end; };

  it("has no unlisted reader or writer, and no listed reason that no longer matches", () => {
    const unlisted: string[] = [];
    const used = new Set<number>();
    const scanned = new Set<string>();
    const check = (file: string, text: string, at: number, write: boolean) => {
      scanned.add(file);
      const allowed = ALLOW.findIndex(([f, needle]) => f === file && text.includes(needle));
      if (allowed >= 0) { used.add(allowed); return; }
      if (write ? !ENCODES.has(file) : !DECODES.has(file)) unlisted.push(`${file}:${at}`);
    };
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const match of source.matchAll(STATEMENT)) {
        const list = match[1];
        const reads = [...list.matchAll(COLUMN)].some((column) => !FIELD_ONLY.test(list.slice(0, column.index!)));
        if (!reads) continue;
        const end = match.index! + match[0].length;
        check(file, source.slice(match.index!, lineEnd(source, end)), lineAt(source, end), false);
      }
      for (const match of source.matchAll(WRITE)) {
        const start = source.lastIndexOf("\n", match.index!) + 1;
        check(file, source.slice(start, lineEnd(source, match.index!)), lineAt(source, match.index!), true);
      }
    }
    expect(unlisted).toEqual([]);
    expect(ALLOW.filter((_, i) => !used.has(i)).map(([f, n]) => `${f}: ${n}`)).toEqual([]);
    for (const file of DECODES) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, file).toMatch(/rowToMessage\(/);
      if (ENCODES.has(file)) expect(source, file).toMatch(/storedJson\(/);
    }
    // every listed decoder is still a reader (a stale entry would hide a moved one)
    expect([...DECODES].filter((f) => !scanned.has(f))).toEqual([]);
  });

  it("catches a reader split across lines or built from a template", () => {
    const reads = (source: string) => [...source.matchAll(STATEMENT)].some((m) => [...m[1].matchAll(COLUMN)].some((c) => !FIELD_ONLY.test(m[1].slice(0, c.index!))));
    expect(reads("db.prepare(\"SELECT json, rowid AS position\n  FROM messages WHERE id=?\")")).toBe(true);
    expect(reads("db.prepare(`SELECT id, ${wide ? \"json\" : \"NULL AS json\"} FROM messages`)")).toBe(true);
    expect(reads("db.prepare(`SELECT m.id, m.json FROM path p\n JOIN messages m ON m.id = p.id`)")).toBe(true);
    expect(reads("db.prepare(\"SELECT json_extract(json, '$.turnId') AS turn, octet_length(json) AS n FROM messages\")")).toBe(false);
  });

  it("leaves no JSON.parse of a json column value outside rowToMessage, in any server file", () => {
    const parses: string[] = [];
    for (const file of files) {
      if (file === "server/transcript-seq.ts" || PARSE_ALLOW.has(file)) continue;
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const match of source.matchAll(PARSE)) parses.push(`${file}:${lineAt(source, match.index!)}`);
    }
    expect(parses).toEqual([]);
  });
});
