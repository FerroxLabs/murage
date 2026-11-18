// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The child of server/prelisten-index-loop.test.ts: a real node process that opens the data folder and dies (SIGKILL: no close, no rollback, no
// handler) at the moment the open asks for the turn index's CREATE INDEX text, which is the first thing its build before listen does. Nothing of
// a build survives a death, whenever in the build it comes, so what the file holds afterwards is what any start that ended during the build left.
// MURAGE_DATA_DIR comes from the parent, a test directory.
import { database } from "../database.ts";
import * as Optional from "../memory/optional-index.ts";

const entry = Optional.OPTIONAL_INDEXES.find(index => index.name === "messages_turn");
if (!entry) throw new Error("messages_turn is not registered");
const sql = entry.sql;
Object.defineProperty(entry, "sql", { configurable: true, get() { process.kill(process.pid, "SIGKILL"); return sql; } });
database();
console.log("NOT_REACHED");
process.exit(3);
