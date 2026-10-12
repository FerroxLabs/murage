// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, afterEach, expect, it } from "vitest";
import { resetObserveWindows, setObserveSink } from "../observe.ts";
import { causeOf, logSwallowed, makeStderrForwarder, resetWorkerLog } from "./worker-log.ts";

let lines: string[];
beforeEach(() => { lines = []; resetWorkerLog(); resetObserveWindows(); setObserveSink(line => lines.push(line)); });
afterEach(() => setObserveSink());

it("names the subsystem and cause once per ten minutes and counts what it folded in", () => {
  expect(logSwallowed("capture", new Error("INVALID_SOURCE_UTF8"), 5000, 0)).toBe(true);
  expect(logSwallowed("capture", new Error("INVALID_SOURCE_UTF8"), 5000, 1000)).toBe(false);
  expect(logSwallowed("index", new Error("INVALID_SOURCE_UTF8"), undefined, 1000)).toBe(true);  // another subsystem is its own entry
  expect(logSwallowed("capture", new Error("INVALID_SOURCE_UTF8"), 5000, 11 * 60_000)).toBe(true);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^\[memory-worker\] subsystem=capture cause=INVALID_SOURCE_UTF8 count=1 since=\S+ next=\S+$/);
  expect(lines[1]).toContain("subsystem=index");
  expect(lines[1]).toContain("next=later");
  expect(lines[2]).toContain("count=3");
});

it("a cause is a short code: sqlite errors carry their code, anything else collapses to its name, never a message with content", () => {
  expect(causeOf(Object.assign(new Error("database is locked"), { errcode: 5, name: "Error" }))).toBe("Error:sqlite5");
  expect(causeOf(new Error("database is locked"))).toBe("SQLITE_BUSY");
  expect(causeOf(new Error("the user said something private about Austin"))).toBe("Error");
  expect(causeOf({})).toBe("unnamed");
  expect(causeOf("MEMORY_WORKER_TIMEOUT")).toBe("MEMORY_WORKER_TIMEOUT");
});

it("the helper's stderr is forwarded line by line, at most N a minute, with home paths removed", () => {
  let now = 0;
  const forward = makeStderrForwarder(2, () => now);
  forward("index drain failed: Error: no such table: lexical\nsecond line at /Users/alex/secret/file.ts:12\nthird");
  forward(" line\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("<path>");
  expect(lines[1]).not.toContain("/Users/alex");
  now = 61_000;
  forward("again\n");
  expect(lines.at(-2)).toBe("[memory-worker] stderr more=1");
  expect(lines.at(-1)).toBe("[memory-worker] stderr again");
});
