// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The scoped word index of memory-index.db (1.0.2 msearch2, r2c P1). Recall chooses which words of a question narrow it by how many
// records THE READER may read hold each word. The FTS5 word list is one list per word across every scope, so counting a reader's share
// of it meant stepping over every other scope's records first: 2,000 private records saying "zephyrine" were enough to change which
// words a bot searched for, and its readable results vanished. Here every posting is keyed (word, scope, record), so a count or a read
// for one scope seeks straight to that scope's postings and never steps over another's.
//
// The words are FTS5's own (the same unicode61 tokenizer as the `lexical` table, run by FTS5 itself through a contentless scratch table
// and its vocabulary), and the postings are kept by triggers on `entries`, so every writer keeps them exact: this build's helper, a test
// that writes the tables directly, and an older build after a downgrade. A file made before this index existed is filled newest first
// by the helper in short steps (MemoryIndex.fillPostings); until it is, `index_meta` holds `postings_below` and recall says it read
// only the newest (`bounded`).
import { DatabaseSync, type StatementSync } from "node:sqlite";

/** The tokenizer of the `lexical` table, and so of the postings. */
export const WORD_TOKENIZER = "unicode61";

// No OR IGNORE in a trigger body: the conflict clause of the statement that fired it (upsert's INSERT OR REPLACE) would override it,
// and a replaced posting_scopes row would get a new key. Existence is tested instead.
const addWords = (scope: string, text: string, seq: string) => `
  INSERT INTO posting_scopes(scope_id,n) SELECT ${scope},(SELECT coalesce(max(n),0)+1 FROM posting_scopes) WHERE NOT EXISTS (SELECT 1 FROM posting_scopes WHERE scope_id=${scope});
  INSERT INTO posting_words(rowid,text) VALUES(1,${text});
  INSERT INTO postings(term,scope,seq) SELECT v.term,p.n,${seq} FROM posting_vocab v JOIN posting_scopes p ON p.scope_id=${scope}
    WHERE NOT EXISTS (SELECT 1 FROM postings o WHERE o.term=v.term AND o.scope=p.n AND o.seq=${seq});
  INSERT INTO posting_words(posting_words) VALUES('delete-all');`;
const dropWords = (scope: string, text: string, seq: string) => `
  INSERT INTO posting_words(rowid,text) SELECT 1,${text} WHERE ${text} IS NOT NULL;
  DELETE FROM postings WHERE term IN (SELECT term FROM posting_vocab) AND scope=(SELECT n FROM posting_scopes WHERE scope_id=${scope}) AND seq=${seq};
  DELETE FROM posting_todo WHERE seq=${seq} AND scope=(SELECT n FROM posting_scopes WHERE scope_id=${scope});
  INSERT INTO posting_words(posting_words) VALUES('delete-all');`;

/** The to-do list of the backfill (MemoryIndex.fillPostings): one row per entry an earlier build indexed whose postings are not written
 * yet, keyed (scope, seq) so a scope's rows are one range and its newest are the end of it. It is empty in steady state (one page) and
 * is never dropped: the triggers below name it. */
export const POSTING_TODO_SCHEMA = "CREATE TABLE IF NOT EXISTS posting_todo(scope INTEGER NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(scope,seq)) WITHOUT ROWID;";

const TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS entries_postings_replace BEFORE INSERT ON entries BEGIN${dropWords(
  "(SELECT scope_id FROM entries WHERE id=NEW.id AND version=NEW.version)",
  "(SELECT text FROM entries WHERE id=NEW.id AND version=NEW.version)",
  "(SELECT rowid FROM entries WHERE id=NEW.id AND version=NEW.version)")}
END;
CREATE TRIGGER IF NOT EXISTS entries_postings_insert AFTER INSERT ON entries BEGIN${addWords("NEW.scope_id", "NEW.text", "NEW.rowid")}
END;
CREATE TRIGGER IF NOT EXISTS entries_postings_delete AFTER DELETE ON entries BEGIN${dropWords("OLD.scope_id", "OLD.text", "OLD.rowid")}
END;
CREATE TRIGGER IF NOT EXISTS entries_postings_update AFTER UPDATE ON entries BEGIN${dropWords("OLD.scope_id", "OLD.text", "OLD.rowid")}${addWords("NEW.scope_id", "NEW.text", "NEW.rowid")}
END;`;

/** The tables and triggers. `seq` is the entry's rowid: a record (re)indexed later has a larger one, so newest first is seq descending. */
export const POSTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS posting_scopes(scope_id TEXT PRIMARY KEY,n INTEGER NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS postings(term TEXT NOT NULL,scope INTEGER NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(term,scope,seq)) WITHOUT ROWID;
CREATE VIRTUAL TABLE IF NOT EXISTS posting_words USING fts5(text,content='',tokenize='${WORD_TOKENIZER}');
CREATE VIRTUAL TABLE IF NOT EXISTS posting_vocab USING fts5vocab(posting_words,'row');
${POSTING_TODO_SCHEMA}${TRIGGERS}`;

/** A file with postings from the build before the to-do list: the list, and the three triggers that must now also clear it. Schema pages
 * only; no entry is read. */
export const POSTINGS_TODO_UPGRADE = `${POSTING_TODO_SCHEMA}
DROP TRIGGER IF EXISTS entries_postings_replace; DROP TRIGGER IF EXISTS entries_postings_delete; DROP TRIGGER IF EXISTS entries_postings_update;${TRIGGERS}`;

/** Fills one existing entry's postings (the backfill): the same work as the insert trigger, on the caller's transaction. */
export function postingFiller(db: DatabaseSync): (scopeId: string, text: string, seq: number) => void {
  const scope = db.prepare("INSERT INTO posting_scopes(scope_id,n) SELECT ?1,(SELECT coalesce(max(n),0)+1 FROM posting_scopes) WHERE NOT EXISTS (SELECT 1 FROM posting_scopes WHERE scope_id=?1)");
  const words = db.prepare("INSERT INTO posting_words(rowid,text) VALUES(1,?1)");
  const add = db.prepare("INSERT OR IGNORE INTO postings(term,scope,seq) SELECT v.term,p.n,?2 FROM posting_vocab v JOIN posting_scopes p ON p.scope_id=?1");
  const clear = db.prepare("INSERT INTO posting_words(posting_words) VALUES('delete-all')");
  return (scopeId, text, seq) => { scope.run(scopeId); words.run(text); add.run(scopeId, seq); clear.run(); };
}

/** The key of `index_meta` that says entries below this rowid are not yet listed in `posting_todo`: every entry at or above it either has
 * its postings or is on that list. While it is there, a reader's page says it read only the newest (`bounded`), for every reader alike. */
export const POSTINGS_BELOW = "postings_below";

let tokenizer: { add: StatementSync; read: StatementSync; clear: StatementSync } | null = null;
/** The words FTS5 makes of `text` (lower case, accents folded, split as the index splits), in index order. A private in-memory
 * connection does the work, so the read-only index handle never writes. */
export function wordTerms(text: string): string[] {
  if (!tokenizer) {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE VIRTUAL TABLE w USING fts5(text,content='',tokenize='${WORD_TOKENIZER}'); CREATE VIRTUAL TABLE v USING fts5vocab(w,'row');`);
    tokenizer = { add: db.prepare("INSERT INTO w(rowid,text) VALUES(1,?)"), read: db.prepare("SELECT term FROM v"), clear: db.prepare("INSERT INTO w(w) VALUES('delete-all')") };
  }
  tokenizer.add.run(text);
  try { return tokenizer.read.all().map(row => String(row.term)); } finally { tokenizer.clear.run(); }
}
