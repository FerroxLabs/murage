// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A stand-in for the native engine-exclusion addon, for tests that run the deletion in a worker thread where a test cannot replace
// `exclOps`: a world in which no engine holds a lock, a file or a folder. server/testing/setup.ts points
// MURAGE_ENGINE_EXCLUSION_PATH here (honoured only in a test process that is not packaged: engine-exclusion.ts). The real addon is
// tested on its own (server/engine-exclusion.test.ts).
"use strict";
const fs = require("node:fs");

module.exports = {
  lock: () => true,
  openers: (devs) => devs.map(() => false),
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
  version: () => 2,
};
