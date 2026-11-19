// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// W13 crash child (docs/designs/1019-roombase-pinned 7): a real SIGKILL of this process inside the E3 transaction (a reply, its
// receipt link and its capture job) or inside a capture step's publishing transaction (E4), on the parent's file database.
import { writeFileSync } from "node:fs";
import { database } from "../../database.ts";
import { appendMessage } from "../../message-db.ts";
import { setMemoryCaptureRoster } from "../capture-scope.ts";
import { captureWork } from "../chunks.ts";
import { linkMemoryDisclosureOutput } from "../disclosures.ts";
import { claimMemoryJob, publishMemoryWork } from "../jobs.ts";
import { roster } from "./xthread-world.ts";

const [cut, reached] = process.argv.slice(2);
setMemoryCaptureRoster(() => roster);
const db = database();
let jobId: string | undefined;
function crash(): never {
  writeFileSync(reached!, JSON.stringify({ cut, jobId }));
  process.kill(process.pid, "SIGKILL");
  throw Error("fixture kill did not end process");
}
const exec = db.exec.bind(db);
const killAtCommit = () => { db.exec = sql => { if (sql === "COMMIT") crash(); exec(sql); }; };
if (cut === "e3") {
  killAtCommit();
  appendMessage("t1", { id: "reply", role: "bot", kind: "text", text: "The reply made in the turn.", at: Date.now(), parentId: "ask" }, () => linkMemoryDisclosureOutput("b1", "reply"));
}
if (cut === "e4") {
  const work = claimMemoryJob("dead-worker");
  if (!work) throw Error("fixture job was not claimable");
  jobId = work.id;
  const result = captureWork(work);
  killAtCommit();
  publishMemoryWork(work, "dead-worker", result);
}
throw Error("fixture crash cut was not reached");
