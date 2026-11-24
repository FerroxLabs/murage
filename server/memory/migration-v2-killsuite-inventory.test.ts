// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: lane I (the kill matrix; designs/memv2-I/KILLSUITE.md "Generator and crash protocol" steps 1 and 7, MAIN board 2931 and 3000).
// The kill-site matrix is generated from the design: every row ID of KILLSUITE.md has exactly one reviewed disposition
// (testing/killsuite-plan.ts REVIEWED), a missing, extra or duplicate row fails here, and the kill harness (migration-v2-kill.test.ts)
// takes its SITES from the rows it drives and asserts each of them was hit and judged. An independent extractor runs the design's
// mechanical queries 1 and 3 over the production roots; every hit is either a design row's source line or a reviewed non-row hit
// (EXTRACTOR_REVIEWED), in both directions, so a new caller of a migration writer fails until it is reviewed.
// Open rows are an exact checked-in ratchet with owners (designs/memv2-I/KILLSUITE-OPEN.tsv), never counted as covered; a production caller
// of a migration writer with no design row fails the extractor (there is no "unrowed" kind: plan row 2d, rows C-bg-keepall/C-bg-upgrade).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { designRows, EXTRACTOR_QUERIES, EXTRACTOR_REVIEWED, forcedCuts, harnessSites, REVIEWED, sourceAnchor, WRITER_ALLOWLIST } from "./testing/killsuite-plan.ts";

const lines = (file: string) => readFileSync(file, "utf8").split("\n");

it("every KILLSUITE.md row has exactly one reviewed disposition, and every reviewed row is a design row", () => {
  const design = designRows().map(row => row.id), reviewed = Object.keys(REVIEWED);
  expect(design.length).toBeGreaterThan(0);
  expect(design.filter(id => !(id in REVIEWED))).toEqual([]);
  expect(reviewed.filter(id => !design.includes(id))).toEqual([]);
});

it("every design source line exists in this tree; a source on a picked pin (`file:line` @ `sha`) is a pin row and is not read here", () => {
  const missing: string[] = [], pinMismatch: string[] = [];
  for (const row of designRows()) {
    const anchor = sourceAnchor(row.source), disposition = REVIEWED[row.id];
    if (!anchor) continue;
    if (anchor.pin || disposition?.s === "pin") {
      if (!(anchor.pin && disposition?.s === "pin" && disposition.pin === anchor.pin)) pinMismatch.push(`${row.id} ${anchor.pin ?? "no pin in design"}`);
      continue;
    }
    if (!existsSync(anchor.file) || (lines(anchor.file)[anchor.line - 1] ?? "").trim() === "") missing.push(`${row.id} ${anchor.file}:${anchor.line}`);
  }
  expect(missing).toEqual([]);
  expect(pinMismatch).toEqual([]);
});

function productionFiles(): string[] {
  const out = ["server/index.ts", "server/database.ts"];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "testing") walk(path); continue; }
      if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(path);
    }
  };
  walk("server/memory");
  return out;
}

it("the independent extractor's hits are exactly the design rows' source lines plus the reviewed non-row hits", () => {
  const anchors = new Set(designRows().map(row => sourceAnchor(row.source)).filter(a => a && !a.pin).map(a => `${a!.file}:${a!.line}`));
  const hits = new Map<string, string>();
  for (const file of productionFiles()) {
    lines(file).forEach((text, index) => {
      if (EXTRACTOR_QUERIES.symbols.test(text) || (file.startsWith("server/memory/") && EXTRACTOR_QUERIES.jobInserts.test(text))) hits.set(`${file}:${index + 1}`, text);
    });
  }
  const unreviewed = [...hits.keys()].filter(key => !anchors.has(key) && !(key in EXTRACTOR_REVIEWED));
  const stale = Object.entries(EXTRACTOR_REVIEWED).filter(([key, [, symbol]]) => !hits.get(key)?.includes(symbol)).map(([key]) => key);
  expect(unreviewed).toEqual([]);
  expect(stale).toEqual([]);
  // the design rows the extractor reaches directly (the runner and lap entry points) stay design rows, not reviewed exceptions
  expect(Object.keys(EXTRACTOR_REVIEWED).filter(key => anchors.has(key))).toEqual([]);
});

it("the kill harness's sites are generated from the reviewed rows, each a task:kind key driving at least one named row; open gaps are named", () => {
  const sites = harnessSites();
  expect([...sites.keys()].filter(site => !/^M[2-6]:[a-z]+$/.test(site))).toEqual([]);
  // one design row per kill site: a second row piggybacked onto a site the harness already judges claims a cut it never drove
  expect([...sites].filter(([, ids]) => ids.length !== 1)).toEqual([]);
  expect(sites.size).toBeGreaterThan(0);
});

// (FABLE/OPUS/ASTRA H1 :74-77, evidence plan row 2a/2c/2d) The open rows are no longer only printed:
// they are an exact, checked-in ratchet (designs/memv2-I/KILLSUITE-OPEN.tsv) with the lane that owns each row's transaction. An open row
// added, dropped or credited without a driven case, or an owner that does not match the row's KILLSUITE.md section
// fails here. This is a ratchet, not coverage: the owner=I rows are lane I's own undriven gap and stay a named High until they are driven.
const SECTION_OWNER: Record<string, string> = {
  "Open, registration, wake and lane I transactions": "I", "M5 retention, lap and real jobs wake": "I", "Required judge rows at each cut": "I",
  "M2 actual revoke drain, flow, transaction boundaries and proof": "C", "M2 receipt flips and pre-existing fold paths": "C",
  "M2 durable deletion/bookkeeping jobs and derived trigger writes": "C", "M3 journal and M4 dead terms": "A", "Interleavings with the real journal applier": "A",
  "M6 collector and its independent writes": "H", "M7 existing self-heal and optional companion writes": "selfheal-1021",
  "Forget fixture, helper index and older-build bridges": "K", "Window and retained-release fences on the picked C/F pins": "F",
  "Trigger coverage for fence and recovery rules": "W", "Additional concrete trigger, replay and helper fences": "W",
};
const RATCHET = "designs/memv2-I/KILLSUITE-OPEN.tsv";
const ratchet = () => new Map(lines(RATCHET).filter(line => line && !line.startsWith("#") && !line.startsWith("id\t")).map(line => line.split("\t") as [string, string]));

it("every design row has an owning lane by its KILLSUITE.md section", () => {
  expect([...new Set(designRows().map(row => row.section))].filter(section => !(section in SECTION_OWNER))).toEqual([]);
});

it("the open rows are exactly the checked-in ratchet, each with its section's owner", () => {
  const owner = new Map(designRows().map(row => [row.id, SECTION_OWNER[row.section]!]));
  const open = Object.entries(REVIEWED).filter(([, d]) => d.s === "open").map(([id]) => [id, owner.get(id)!] as const);
  const want = new Map(open), have = ratchet();
  expect([...want].filter(([id]) => !have.has(id)).map(([id, o]) => `${id}\t${o}`), `open rows missing from ${RATCHET}`).toEqual([]);
  expect([...have.keys()].filter(id => !want.has(id)), `rows in ${RATCHET} that are not open (driven, pinned or gone): remove them`).toEqual([]);
  expect([...want].filter(([id, o]) => have.get(id) !== o).map(([id, o]) => `${id} ${have.get(id)} != ${o}`), "ratchet owner").toEqual([]);
});

// (FABLE/OPUS/ASTRA 3350e31a9a H1, plan row 2b) lane I's own transaction rows are driven by a forced child kill each
// (migration-v2-kill-forced.test.ts, one case per cut): a forced row is a lane-I row, its cut names its own task and statement, and each
// I2..I5 begin/precommit/rollback/publish row, R-lap-begin/-open/-commit/-due/-subscribe and O07..O10 is forced (never open again, never piggybacked on another cut).
it("lane I's batch-transaction rows are each driven by their own forced child-kill cut", () => {
  const owner = new Map(designRows().map(row => [row.id, SECTION_OWNER[row.section]!]));
  const forced = forcedCuts();
  const want = [...["2", "3", "4", "5"].flatMap(t => ["begin", "precommit", "rollback", "publish"].map(k => [`I${t}-${k}`, `M${t}:${k}`])), ["R-lap-begin", "lap:begin"], ["R-lap-open", "lap:precommit"], ["R-lap-commit", "lap:commit"], ["R-lap-due", "lap:due"], ["O07", "open:reopen"], ["O08", "M3:noprogress"], ["O09", "run:stall"], ["O10", "run:admission"], ["R-lap-subscribe", "run:jobs"]];
  expect(want.filter(([id, cut]) => !(forced.get(cut ?? "")?.length === 1 && forced.get(cut!)![0] === id)), "I2..I5 transaction rows without their own forced cut").toEqual([]);
  expect([...forced.values()].flat().filter(id => owner.get(id) !== "I"), "forced rows owned by another lane").toEqual([]);
  // (ASTRA 4383c77075) the credited count is exact: 25 rows (16 I2..I5 + 5 R-lap + O07..O10), and nothing else is credited as forced
  expect([want.length, [...forced.values()].flat().sort()], "forced rows: exactly the 25 credited lane-I rows").toEqual([25, want.map(([id]) => id!).sort()]);
});

// (HARNESS-DESIGN C2 (i)) every WRITER_ALLOWLIST function exists in its production file (a renamed writer would make attribution credit
// nothing and fail every seed; a listed name that is gone must fail here, at the table), and the table has no harness or any row
it("every WRITER_ALLOWLIST row names production functions that exist, and no row is a harness or wildcard writer", () => {
  const missing = WRITER_ALLOWLIST.flatMap(row => {
    const text = readFileSync(fileURLToPath(new URL(`../${row.file}`, import.meta.url)), "utf8");
    return row.fns.filter(fn => !new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${fn}\\(`).test(text)).map(fn => `${row.file}:${fn}`);
  });
  expect([missing, WRITER_ALLOWLIST.filter(row => /test|testing|\*|any|harness/.test(`${row.file} ${row.fns.join(" ")}`)).map(row => row.file)], "WRITER_ALLOWLIST").toEqual([[], []]);
});
