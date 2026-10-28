// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A stand-in for the native engine-exclusion addon, for tests that run the deletion in a worker thread where a test cannot replace
// `exclOps`: a world in which no engine holds a lock, a file or a folder. server/testing/setup.ts points
// MURAGE_ENGINE_EXCLUSION_PATH here (honoured only in a test process that is not packaged: engine-exclusion.ts). The real addon is
// tested on its own (server/engine-exclusion.test.ts).
"use strict";
const fs = require("node:fs");

// $MURAGE_TEST_EXTRA_PROCESSES (JSON, a list of processes): more processes the machine runs, for a test whose deletion runs in a worker
// thread (a worker takes the environment it was started with). Unset or unreadable: none.
const extraProcesses = () => {
  try { const list = JSON.parse(process.env.MURAGE_TEST_EXTRA_PROCESSES || "[]"); return Array.isArray(list) ? list : []; } catch { return []; }
};

module.exports = {
  lock: () => true,
  // a world with no engine running: only this process and its parent, which any complete list holds (engine-closed.ts refuses a list without them)
  processes: () => [
    { pid: process.pid, ppid: process.ppid, mine: true, uid: typeof process.getuid === "function" ? process.getuid() : null, start: 1, comm: "node", exe: process.execPath, argv: [process.execPath, "test"] },
    { pid: process.ppid, ppid: 1, mine: true, uid: typeof process.getuid === "function" ? process.getuid() : null, start: 1, comm: "test-parent", exe: "/usr/bin/test-parent", argv: ["test-parent"] },
    ...extraProcesses(),
  ],
  // never over an existing name: a file is linked then unlinked (atomic and refusing to replace), a folder checked then renamed
  renameNoReplace: (from, to) => {
    const stat = fs.lstatSync(from);
    if (stat.isDirectory()) {
      try { fs.lstatSync(to); return 1; } catch (error) { if (error.code !== "ENOENT") throw error; }
      fs.renameSync(from, to);
      return 0;
    }
    try { fs.linkSync(from, to); } catch (error) { if (error.code === "EEXIST") return 1; throw error; }
    fs.unlinkSync(from);
    return 0;
  },
  // no other process has any file open for writing; a sync is a plain fsync, reported as the full barrier
  writers: () => ({ writers: [], unreadable: [] }),
  fullSync: (fd) => { fs.fsyncSync(fd); return "full"; },
  version: () => 10,
};
