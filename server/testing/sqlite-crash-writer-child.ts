// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Child of sqlite-hiddencost-crash-1022.test.ts (owner: q1022-sqlite-opus): the production store (database.ts, message-db.ts insertMessage)
// writes messages one transaction at a time and prints each id only after its commit returned. The parent kills it with SIGKILL mid-run.
import { randomUUID } from "node:crypto";
import { database, transaction } from "../database.ts";
import { insertMessage } from "../message-db.ts";

const thread = process.argv[2]!;
database();
let n = 0;
for (;;) {
  const id = randomUUID();
  transaction(() => insertMessage(thread, { id, at: ++n, role: "user", kind: "text", text: `crash fixture line ${n} ${"x".repeat(2000)}` }));
  process.stdout.write(`COMMITTED ${id}\n`);
}
