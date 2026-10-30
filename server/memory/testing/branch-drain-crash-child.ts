// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helper: drains the pending branch changes of the data folder in MURAGE_DATA_DIR one row at a time and dies by SIGKILL at the COMMIT
// numbered argv[2] (0 based), with that slice written and not committed. The file in argv[3] says it got that far. Any other end is an
// exit code the parent refuses.
import { writeFileSync } from "node:fs";
import { database } from "../../database.ts";
import { branchChangeTuning, runBranchChangeSlice } from "../branch-change.ts";

branchChangeTuning.slice = 1;
const db = database(), exec = db.exec.bind(db);
let commits = 0;
db.exec = (sql: string) => {
  if (sql === "COMMIT" && commits++ === Number(process.argv[2])) { writeFileSync(String(process.argv[3]), "reached"); process.kill(process.pid, "SIGKILL"); process.exit(5); }
  exec(sql);
};
try { while (runBranchChangeSlice(db)) { /* the kill ends this */ } } catch { process.exit(4); }
process.exit(3); // no pending row reached that COMMIT
