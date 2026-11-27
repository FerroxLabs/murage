// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: lane E (memv2, status-scan.ts). MAIN 11-21 DATA_VERSION READS: a stamp never reads data_version as the unqualified table-valued
// pragma_data_version, which resolves to a TEMP table or view of that name first; writeStampOf must still see another connection's commit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { writeStampOf } from "./status-scan.ts";

it("W-E-DATA-VERSION writeStampOf moves on another connection's commit even with a TEMP view named pragma_data_version", () => {
  const dir = mkdtempSync(join(tmpdir(), "stamp-")), file = join(dir, "memory.db");
  const reader = new DatabaseSync(file), writer = new DatabaseSync(file);
  try {
    writer.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES(1)");
    reader.prepare("SELECT count(*) FROM t").get();
    reader.exec("CREATE TEMP VIEW pragma_data_version AS SELECT 7 AS data_version");
    const before = writeStampOf(reader);
    writer.exec("INSERT INTO t VALUES(2)");
    expect(writeStampOf(reader), "a foreign commit moves the stamp").not.toBe(before);
  } finally { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});
