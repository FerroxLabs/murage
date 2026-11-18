// SPDX-License-Identifier: AGPL-3.0-or-later
// Test fixture child for W-KILL: drains a seeded ledger and SIGKILLs itself at the Nth COMMIT (after it returned) or the Nth BEGIN (before any work).
// Every send writes its delivery id to fd 3 first: the independent oracle for "at most one send attempt per record".
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DurableDelivery } from "./durable-delivery.ts";

const [file = "", mode = "commit", target = "1"] = process.argv.slice(2);
let seen = 0;
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
  const opening = mode === "begin" && sql.startsWith("BEGIN");
  if (opening && ++seen === Number(target)) process.kill(process.pid, "SIGKILL");
  const result = exec.call(this, sql);
  if (mode === "commit" && sql === "COMMIT" && ++seen === Number(target)) process.kill(process.pid, "SIGKILL");
  return result;
} as typeof exec;

const ledger = new DurableDelivery({ file, bindingKey: "binding", recipient: "owner", isCurrent: () => true, now: () => 1_000_000_000,
  runs: { enqueue: () => ({ id: "run" }), result: () => ({ status: "completed", output: "answer" }) },
  send: async input => { writeSync(3, `${input.deliveryId}\n`); return { recipient: "owner", messageId: "m1" }; } });
await ledger.drain();
ledger.stop();
