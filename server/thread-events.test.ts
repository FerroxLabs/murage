import { appendFileSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: vi.fn(fs.openSync), readSync: vi.fn(fs.readSync) };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const { readThreadEvents } = await import(process.env.MURAGE_THREAD_EVENTS_CONTROL_ENTRY ?? "./thread-events.ts") as typeof import("./thread-events.ts");

function measuredReads() {
  const paths = new Map<number, string>();
  const bytes = new Map<string, number>();
  vi.mocked(openSync).mockImplementation(((...args: unknown[]) => {
    const fd = Reflect.apply(actualFs.openSync, null, args) as number;
    paths.set(fd, String(args[0]));
    return fd;
  }) as typeof openSync);
  vi.mocked(readSync).mockImplementation(((...args: unknown[]) => {
    const count = Reflect.apply(actualFs.readSync, null, args) as number;
    const path = paths.get(args[0] as number)!;
    bytes.set(path, (bytes.get(path) ?? 0) + count);
    return count;
  }) as typeof readSync);
  return bytes;
}

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "murage-thread-events-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.mocked(openSync).mockImplementation(actualFs.openSync);
  vi.mocked(readSync).mockImplementation(actualFs.readSync);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const line = (o: unknown) => JSON.stringify(o) + "\n";
const runtime = (event: Record<string, unknown>) => ({ provider: "test", threadId: "t1", ...event });

describe("readThreadEvents", () => {
  it("returns an empty page when neither log exists", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1" })).toEqual({
      entries: [],
      total: { runtime: 0, native: 0 },
      totalComplete: { runtime: true, native: true },
    });
  });

  it("merges runtime and native lines by time, tagging their source", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(runtime({ eventId: "e1", type: "turn.started", createdAt: "2026-08-17T10:00:00.000Z" })) +
        line(runtime({ eventId: "e2", type: "turn.completed", createdAt: "2026-08-17T10:00:02.000Z", ok: true })),
    );
    writeFileSync(
      join(nativeDir, "t1.ndjson"),
      line({ at: "2026-08-17T10:00:01.000Z", dir: "out", source: "claude.sdk.message", msg: { type: "user" } }),
    );
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.total).toEqual({ runtime: 2, native: 1 });
    expect(page.entries.map((e) => [e.kind, e.at])).toEqual([
      ["runtime", "2026-08-17T10:00:00.000Z"],
      ["native", "2026-08-17T10:00:01.000Z"],
      ["runtime", "2026-08-17T10:00:02.000Z"],
    ]);
    // each entry keeps its original record whole under `data`
    expect(page.entries[1]).toMatchObject({ kind: "native", data: { dir: "out", msg: { type: "user" } } });
    expect(page.entries[0]).toMatchObject({ kind: "runtime", data: { eventId: "e1" } });
  });

  it("caps each log to its most recent `limit` lines and reports what it skipped", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    let body = "";
    for (let i = 0; i < 10; i++) {
      body += line(runtime({ eventId: `e${i}`, type: "content.delta", createdAt: `2026-08-17T10:00:${String(i).padStart(2, "0")}.000Z`, streamKind: "assistant_text", delta: String(i) }));
    }
    writeFileSync(join(eventsDir, "t1.ndjson"), body);
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 3 });
    expect(page.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(["e7", "e8", "e9"]);
    expect(page.total.runtime).toBe(10);
  });

  it("skips a corrupt line rather than failing the whole read", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(runtime({ eventId: "e1", type: "turn.started", createdAt: "2026-08-17T10:00:00.000Z" })) +
        "{not json\n" +
        line(runtime({ eventId: "e2", type: "turn.completed", createdAt: "2026-08-17T10:00:02.000Z", ok: true })),
    );
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.entries).toHaveLength(2);
    // `total` is the number of non-empty log lines; malformed records are
    // counted but deliberately absent from the returned entries.
    expect(page.total.runtime).toBe(3);
  });

  it("discards JSON-valid records that do not satisfy the inspector wire contract", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(null) +
        line({ eventId: "incomplete", provider: "claude", threadId: "t1", createdAt: "1", type: "content.delta", streamKind: "assistant_text" }) +
        line({ eventId: "valid", provider: "claude", threadId: "t1", createdAt: "2", type: "content.delta", streamKind: "assistant_text", delta: "ok" }),
    );
    writeFileSync(join(nativeDir, "t1.ndjson"), line(null) + line({ at: "2", dir: "in", source: "claude", msg: {} }));
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.entries.map((entry) => [entry.kind, (entry.data as { eventId?: string }).eventId])).toEqual([
      ["runtime", "valid"],
      ["native", undefined],
    ]);
    expect(page.total).toEqual({ runtime: 3, native: 2 });
  });

  it("rejects malformed retry telemetry while retaining a valid retry event", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const retry = (eventId: string, attempt: unknown, delayMs: unknown, reason: unknown) =>
      runtime({ eventId, createdAt: eventId, type: "turn.retrying", attempt, delayMs, reason });
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line(retry("fractional", 1.5, 1_000, "overloaded")) +
        line(retry("negative-attempt", -1, 1_000, "overloaded")) +
        line(retry("negative-delay", 1, -1, "overloaded")) +
        line(retry("infinite-delay", 1, Number.POSITIVE_INFINITY, "overloaded")) +
        line(retry("missing-reason", 1, 1_000, undefined)) +
        line(retry("valid-retry", 1, 1_000, "overloaded")),
    );

    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.entries.map((entry) => (entry.data as { eventId: string }).eventId)).toEqual(["valid-retry"]);
  });

  it("keeps walking backward when a corrupt tail record would otherwise consume the limit", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const body = Array.from({ length: 20 }, (_, i) =>
      line(runtime({ eventId: `e${i}`, type: "content.delta", createdAt: `2026-08-17T10:00:${String(i).padStart(2, "0")}.000Z`, streamKind: "assistant_text", delta: String(i) })),
    ).join("");
    writeFileSync(join(eventsDir, "t1.ndjson"), body + "{broken}\n");
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 3 });
    expect(page.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(["e17", "e18", "e19"]);
    expect(page.total.runtime).toBe(21);
  });

  it("normalizes non-finite and fractional limits at the helper boundary", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(join(eventsDir, "t1.ndjson"), line(runtime({ eventId: "e1", createdAt: "1", type: "turn.started" })) + line(runtime({ eventId: "e2", createdAt: "2", type: "turn.started" })));
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: Number.NaN }).entries).toHaveLength(2);
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 1.9 }).entries).toHaveLength(1);
  });

  it("updates cached totals from appended bytes and preserves multibyte records across read chunks", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const file = join(eventsDir, "t1.ndjson");
    writeFileSync(file, line(runtime({ eventId: "large", createdAt: "1", type: "turn.started", text: "🐭".repeat(40_000) })));
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 2 }).total.runtime).toBe(1);

    appendFileSync(file, line(runtime({ eventId: "latest", createdAt: "2", type: "turn.started" })));
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 2 });
    expect(page.total.runtime).toBe(2);
    expect(page.entries.map((entry) => (entry.data as { eventId: string }).eventId)).toEqual(["large", "latest"]);
    expect((page.entries[0]!.data as { text: string }).text.startsWith("🐭🐭")).toBe(true);
  });

  it("refuses a thread id that could escape the log directory", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    expect(() => readThreadEvents({ eventsDir, nativeDir, threadId: "../bots" })).toThrow(/thread id/);
  });

  it("bounds cold and large-growth reads per file, resumes counting, and never changes log bytes", () => {
    const eventsDir = tmp(), nativeDir = tmp();
    const eventFile = join(eventsDir, "t1.ndjson"), nativeFile = join(nativeDir, "t1.ndjson");
    const recent = line(runtime({ eventId: "recent", createdAt: "2", type: "turn.started" }));
    const nativeRecent = line({ at: "2", dir: "in", source: "fixture", msg: "recent" });
    const oversizedPrefix = "x".repeat(20 * 1024 * 1024) + "\n";
    const eventBytes = oversizedPrefix + recent;
    const nativeBytes = oversizedPrefix + nativeRecent;
    writeFileSync(eventFile, eventBytes);
    writeFileSync(nativeFile, nativeBytes);
    const measured = measuredReads();
    const request = () => readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 1 });
    const first = request();
    // The baseline control must fail on measured I/O before new metadata.
    for (const file of [eventFile, nativeFile]) expect(measured.get(file)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(first.totalComplete).toEqual({ runtime: false, native: false });
    expect(first.entries).toHaveLength(2);
    expect(first.entries[0]?.data).toMatchObject({ eventId: "recent" });
    measured.clear();
    expect(request().totalComplete).toEqual({ runtime: false, native: false });
    for (const file of [eventFile, nativeFile]) expect(measured.get(file)).toBeLessThanOrEqual(16 * 1024 * 1024);
    measured.clear();
    const complete = request();
    expect(complete.totalComplete).toEqual({ runtime: true, native: true });
    expect(complete.total).toEqual({ runtime: 2, native: 2 });
    expect(readFileSync(eventFile, "utf8")).toBe(eventBytes);
    expect(readFileSync(nativeFile, "utf8")).toBe(nativeBytes);

    appendFileSync(eventFile, oversizedPrefix + recent);
    measured.clear();
    const grown = request();
    expect(measured.get(eventFile)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(grown.totalComplete?.runtime).toBe(false);
    expect(grown.entries.some((entry) => entry.kind === "runtime")).toBe(true);
    expect(readFileSync(eventFile, "utf8")).toBe(eventBytes + oversizedPrefix + recent);
  });

  it("carries a partial line across the counting budget and resets after truncation or inode replacement", () => {
    const eventsDir = tmp(), nativeDir = tmp();
    const file = join(eventsDir, "t1.ndjson");
    writeFileSync(file, "x".repeat(8 * 1024 * 1024 - 1) + "\r\n" + line(runtime({ eventId: "tail", createdAt: "1", type: "turn.started" })));
    const first = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 1 });
    expect(first.totalComplete?.runtime).toBe(false);
    const second = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 1 });
    expect(second.total.runtime).toBe(2);
    expect(second.totalComplete?.runtime).toBe(true);
    writeFileSync(file, line(runtime({ eventId: "truncated", createdAt: "2", type: "turn.started" })));
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1" }).total.runtime).toBe(1);
    renameSync(file, file + ".old");
    writeFileSync(file, line(runtime({ eventId: "replacement", createdAt: "3", type: "turn.started" })));
    const replacement = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(replacement.total).toEqual({ runtime: 1, native: 0 });
    expect(replacement.totalComplete).toEqual({ runtime: true, native: true });
    expect(replacement.entries[0]?.data).toMatchObject({ eventId: "replacement" });
  });

  it("marks unreadable files and failed counts incomplete instead of reporting exact zero", () => {
    const eventsDir = tmp(), nativeDir = tmp();
    const file = join(eventsDir, "t1.ndjson");
    writeFileSync(file, line(runtime({ eventId: "one", createdAt: "1", type: "turn.started" })));
    vi.mocked(openSync).mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1" }).totalComplete).toEqual({ runtime: false, native: true });
    vi.mocked(readSync).mockImplementationOnce(() => { throw Object.assign(new Error("read failed"), { code: "EIO" }); });
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.totalComplete?.runtime).toBe(false);
    expect(page.entries).toHaveLength(1);
  });
});
