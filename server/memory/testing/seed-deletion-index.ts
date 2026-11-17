// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture corpus producer and scheduler consumer owner: c3-memory.
// Seeding an existing installation is separate from its runtime I/O ledger.
import { DatabaseSync } from "node:sqlite";
import { openTestIndex, put, closeSealed } from "./open-index.ts";

const path = process.argv[2];
const { unmerged, scope, ids, filler, marker } = JSON.parse(process.argv[3]) as {
  unmerged: boolean; scope: string; ids: string[]; filler: number; marker: string;
};
const index = await openTestIndex(path);
try {
  if (unmerged) {
    const db = new DatabaseSync(path);
    try { db.exec("INSERT INTO lexical(lexical,rank) VALUES('automerge',0); INSERT INTO lexical(lexical,rank) VALUES('crisismerge',1000)"); }
    finally { db.close(); }
  }
  for (let at = 0; at < filler; at += 16) {
    await put(index, Array.from({ length: 16 }, (_, k) => ({ id: `filler-${at + k}`, version: 1, scopeId: scope, deleted: false,
      text: Array.from({ length: 60 }, (_, word) => `fillerterm${at + k}part${word}`).join(" ") })));
  }
  for (let at = 0; at < ids.length; at += 16) await put(index, ids.slice(at, at + 16).map(id => ({ id, version: 1, scopeId: scope, deleted: false, text: `${marker} ${id}` })));
} finally { await closeSealed(index); }
