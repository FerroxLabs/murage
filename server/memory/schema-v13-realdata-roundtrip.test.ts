// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// v13 upgrade and downgrade on a real data COPY (1.0.7 memory-recall-hydration): opens the copy (whatever version it holds goes to v13),
// then, with ROUNDTRIP_STEP=down, downgrades it to v12 (the memory-downgrade command's own function) so a 1.0.6 build can open it; with
// ROUNDTRIP_STEP=check it only opens and reports. Prints the schema version, the stamp table's row count and the validator's verdict: counts
// and fixed codes only. Skipped unless ROUNDTRIP_SCRATCH_ROOT names a scratch folder and ROUNDTRIP_COPY a copied data dir INSIDE it.
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

const COPY = process.env.ROUNDTRIP_COPY;
if (COPY) process.env.MURAGE_DATA_DIR = COPY;
const SCRATCH = process.env.ROUNDTRIP_SCRATCH_ROOT;
const STEP = process.env.ROUNDTRIP_STEP ?? "check";
const ON = Boolean(COPY) && Boolean(SCRATCH);
/** Real paths (symlinks followed): a link inside the scratch root never names a dir outside it. A path that does not exist stays as given. */
const real = (dir: string) => { try { return realpathSync(resolve(dir)); } catch { return resolve(dir); } };
const insideScratch = (dir: string) => { const root = real(SCRATCH!); const at = real(dir); return at !== root && at.startsWith(root.endsWith(sep) ? root : root + sep); };
const codeOf = (error: unknown): string => { const m = error instanceof Error ? /^(MEMORY_[A-Z0-9_]{1,60})(?::|$)/.exec(error.message) : null; return m ? m[1]! : "other"; };
const out = (o: Record<string, unknown>) => console.log(`ROUNDTRIP ${JSON.stringify(o)}`);

function report(label: string, file: string, validate: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const n = (sql: string) => { try { return Number((db.prepare(sql).get() as any)?.n); } catch { return null; } };
    let verdict = "ok";
    try { validate(db); } catch (error) { verdict = codeOf(error); }
    out({ k: label, version: n("SELECT schema_version AS n FROM memory_meta WHERE id=1"), stampTable: n("SELECT count(*) AS n FROM sqlite_schema WHERE name='memory_source_lsn'"),
      stampTrigger: n("SELECT count(*) AS n FROM sqlite_schema WHERE name='memory_source_lsn_insert'"), stamps: n("SELECT count(*) AS n FROM memory_source_lsn"),
      sourceVersions: n("SELECT count(*) AS n FROM memory_source_versions"), flowLastObjects: n("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('memory_thread_flow_last','memory_thread_flow_last_insert')"),
      flowLast: n("SELECT count(*) AS n FROM memory_thread_flow_last"), flowEdges: n("SELECT count(*) AS n FROM memory_thread_flow"), validator: verdict });
  } finally { db.close(); }
}

describe.skipIf(!ON)("v13 round trip on a real data copy", () => {
  it(`step ${STEP}`, async () => {
    vi.resetModules();
    const { DATA_DIR } = await import("../config.ts");
    const { database, closeDatabase } = await import("../database.ts");
    const { validateMemorySchema, MEMORY_SCHEMA_VERSION } = await import("./schema.ts");
    const { downgradeInstallationMemorySchema } = await import("../installation-memory-downgrade.ts");
    if (!insideScratch(COPY!) || real(DATA_DIR) !== real(COPY!) || real(DATA_DIR) === real(join(homedir(), ".murage"))) throw new Error("REFUSING: the data dir must be the named copy inside ROUNDTRIP_SCRATCH_ROOT");
    const file = join(DATA_DIR, "messages.db");
    report("before-open", file, validateMemorySchema);
    const t0 = performance.now();
    database();
    out({ k: "open", ms: Math.round(performance.now() - t0), build: MEMORY_SCHEMA_VERSION });
    closeDatabase();
    report("after-open", file, validateMemorySchema);
    if (STEP === "down") {
      const t1 = performance.now();
      let status = "ok";
      try { downgradeInstallationMemorySchema(DATA_DIR, 12); } catch (error) { status = codeOf(error); }
      out({ k: "downgrade", to: 12, ms: Math.round(performance.now() - t1), status });
      report("after-downgrade", file, validateMemorySchema);
      expect(status).toBe("ok");
    }
  });
});
