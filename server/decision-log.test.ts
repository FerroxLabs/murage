// The decision log's own mechanics: what a row looks like on disk, that
// credential-shaped content never reaches the file, that the file stays
// private, and that rotation keeps the fleet-wide log bounded without
// losing the recent past. The WIRING — which decisions get written at all
// — is pinned separately in decision-log-wiring.test.ts.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendDecision, decisionLogQueueStatus, DECISION_MAX_PENDING_BYTES, DECISION_MAX_PENDING_RECORDS, flushDecisionLog, readDecisions, type DecisionRow } from "./decision-log.ts";
import { removeTempDir } from "./testing/cleanup.ts";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, appendFile: vi.fn(actual.appendFile) };
});

let dir: string;
const file = () => join(dir, "decisions.ndjson");

const row = (overrides: Partial<DecisionRow> = {}): Omit<DecisionRow, "at"> => ({
  threadId: "t1",
  requestId: "req-1",
  botId: "b1",
  botName: "Scout",
  tool: "Bash",
  summary: "git status",
  decision: "auto-approved",
  source: "always-allow",
  rule: "Bash:git",
  ...overrides,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murage-decisions-"));
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe("appendDecision / readDecisions", () => {
  it.each([1, 5, 10])("bounds retained rows from %i producers while disk is delayed and records the gap", async producers => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(appendFile).mockImplementationOnce(async (...args) => { await gate; return actual.appendFile(...args); });
    let produced = 0;
    try {
      for (let n = 0; n < 300; n++) for (let producer = 0; producer < producers; producer++) {
        appendDecision(dir, row({ requestId: `req-${produced++}`, summary: "x".repeat(8192) }));
        const status = decisionLogQueueStatus(dir);
        expect(status.pendingBytes).toBeLessThanOrEqual(DECISION_MAX_PENDING_BYTES);
        expect(status.pendingRecords).toBeLessThanOrEqual(DECISION_MAX_PENDING_RECORDS);
      }
      const blocked = decisionLogQueueStatus(dir);
      expect(blocked.omitted).toBeGreaterThan(0);
      expect(blocked.pendingRecords + blocked.omitted).toBe(produced);
    } finally { release(); }
    await flushDecisionLog(dir);
    const rows = readDecisions(dir, 10_000);
    const receipts = rows.filter(value => value.decision !== "log-omitted");
    const marker = rows.filter(value => value.decision === "log-omitted");
    expect(marker).toHaveLength(1);
    expect(marker[0].omitted).toBe(produced - receipts.length);
    expect(receipts.map(value => value.requestId)).toEqual(Array.from({ length: receipts.length }, (_, index) => `req-${index}`));
    expect(decisionLogQueueStatus(dir)).toEqual({ pendingBytes: 0, pendingRecords: 0, omitted: 0 });
    appendDecision(dir, row({ requestId: "after-recovery" }));
    await flushDecisionLog(dir);
    expect(readDecisions(dir, 1)[0].requestId).toBe("after-recovery");
  });

  it("bounds tiny records by count and oversized records by bytes", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(appendFile).mockImplementationOnce(async (...args) => { await gate; return actual.appendFile(...args); });
    try {
      for (let n = 0; n < 300; n++) appendDecision(dir, row({ requestId: `tiny-${n}` }));
      expect(decisionLogQueueStatus(dir).pendingRecords).toBe(DECISION_MAX_PENDING_RECORDS);
      appendDecision(dir, row({ summary: "secret-shaped raw data".repeat(10_000) }));
      expect(decisionLogQueueStatus(dir).omitted).toBe(45);
    } finally { release(); }
    await flushDecisionLog(dir);
    expect(readDecisions(dir, 1)[0]).toMatchObject({ decision: "log-omitted", omitted: 45 });
    expect(readFileSync(file(), "utf8")).not.toContain("secret-shaped raw data");
  });

  it("releases failed writes and queued rows, retaining only a count until disk recovery", async () => {
    vi.mocked(appendFile).mockRejectedValueOnce(new Error("fake ENOSPC"));
    for (let n = 0; n < 10; n++) appendDecision(dir, row({ requestId: `failed-${n}` }));
    await flushDecisionLog(dir);
    expect(decisionLogQueueStatus(dir)).toEqual({ pendingBytes: 0, pendingRecords: 0, omitted: 10 });
    appendDecision(dir, row({ requestId: "recovered" }));
    await flushDecisionLog(dir);
    const rows = readDecisions(dir, 10);
    expect(rows[0].requestId).toBe("recovered");
    expect(rows[1]).toMatchObject({ decision: "log-omitted", source: "logger", omitted: 10 });
    expect(decisionLogQueueStatus(dir)).toEqual({ pendingBytes: 0, pendingRecords: 0, omitted: 0 });
  });

  it("writes one NDJSON row per decision and reads them back newest last", async () => {
    appendDecision(dir, row());
    appendDecision(dir, row({ requestId: "req-2", decision: "card-shown", source: "no-grant", rule: undefined }));
    await flushDecisionLog(dir);
    const rows = readDecisions(dir, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0].decision).toBe("auto-approved");
    expect(rows[0].rule).toBe("Bash:git");
    expect(rows[0].botName).toBe("Scout");
    expect(Number.isNaN(new Date(rows[0].at).getTime())).toBe(false);
    expect(rows[1].decision).toBe("card-shown");
    expect(rows[1].source).toBe("no-grant");
  });

  it("returns only the newest `limit` rows", async () => {
    for (const id of ["req-1", "req-2", "req-3"]) appendDecision(dir, row({ requestId: id }));
    await flushDecisionLog(dir);
    const rows = readDecisions(dir, 2);
    expect(rows.map((r) => r.requestId)).toEqual(["req-2", "req-3"]);
  });

  it("keeps credential-shaped content out of the written row", async () => {
    // Both shapes redact.ts guards against: a known key prefix, and a
    // KEY=value pair with a secret-shaped name. The summary is whatever
    // the agent typed — this is exactly how a key ends up in a log.
    const secret = "sk-live-abcdefghijklmnop1234";
    appendDecision(dir, row({ summary: `export STRIPE_API_KEY=${secret}` }));
    await flushDecisionLog(dir);
    const raw = readFileSync(file(), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("redacted");
    expect(readDecisions(dir, 10)[0].summary).toContain("redacted");
  });

  it.skipIf(process.platform === "win32")("creates the file private (0600)", async () => {
    appendDecision(dir, row());
    await flushDecisionLog(dir);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("rotates to a single .1 file at the cap, still reads across the seam, and stays bounded", async () => {
    // maxBytes 1: every append after the first finds the live file over
    // the cap and rotates it — three appends walk a row off the end.
    appendDecision(dir, row({ requestId: "req-A" }), { maxBytes: 1 });
    appendDecision(dir, row({ requestId: "req-B" }), { maxBytes: 1 });
    appendDecision(dir, row({ requestId: "req-C" }), { maxBytes: 1 });
    await flushDecisionLog(dir);
    expect(existsSync(`${file()}.1`)).toBe(true);
    // req-A has aged out entirely — the log is bounded, not archival —
    // while a read spanning the rotation still sees .1 before the live file
    expect(readDecisions(dir, 10).map((r) => r.requestId)).toEqual(["req-B", "req-C"]);
  });

  it("skips a corrupt line instead of losing the rows around it", async () => {
    appendDecision(dir, row({ requestId: "req-1" }));
    await flushDecisionLog(dir);
    appendFileSync(file(), "not json at all\n");
    appendDecision(dir, row({ requestId: "req-2" }));
    await flushDecisionLog(dir);
    expect(readDecisions(dir, 10).map((r) => r.requestId)).toEqual(["req-1", "req-2"]);
  });

  it("reads an empty log as an empty list, not an error", () => {
    expect(readDecisions(dir, 10)).toEqual([]);
  });

  it("serializes a burst without dropping or reordering rows", async () => {
    for (let i = 0; i < 100; i += 1) appendDecision(dir, row({ requestId: `req-${i}` }));
    await flushDecisionLog(dir);
    expect(readDecisions(dir, 100).map((entry) => entry.requestId)).toEqual(
      Array.from({ length: 100 }, (_, i) => `req-${i}`),
    );
  });
});
