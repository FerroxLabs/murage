// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureServerInstancePublished, resetServerInstanceForTests, SERVER_INSTANCE, SERVER_INSTANCE_PATTERN, STALE_INSTANCE_EXIT, writeServerInstance } from "./server-instance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "server-instance-")); resetServerInstanceForTests(); });
afterEach(() => { removeTempDirSync(dir); vi.unstubAllEnvs(); });

it("r7 the id is a strict token and the stale exit is distinct from busy (75) and generic failure (1)", () => {
  expect(SERVER_INSTANCE).toMatch(SERVER_INSTANCE_PATTERN);
  expect(STALE_INSTANCE_EXIT).toBe(76);
});
it("r7 writes id plus newline with mode 0600 through a temp file, leaving nothing behind, and replaces atomically", () => {
  const file = join(dir, ".server-instance");
  writeServerInstance(file, "A".repeat(22));
  expect(readFileSync(file, "utf8")).toBe(`${"A".repeat(22)}\n`);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  writeServerInstance(file, "B".repeat(22));
  expect(readFileSync(file, "utf8")).toBe(`${"B".repeat(22)}\n`);
  expect(readdirSync(dir)).toEqual([".server-instance"]);
  expect(() => writeServerInstance(file, "bad id!")).toThrow("Invalid server instance");
});
it("r7 a failed write keeps the previous value and removes its temp file", () => {
  const file = join(dir, ".server-instance");
  writeServerInstance(file, "A".repeat(22));
  const failing = { open: vi.fn(() => 99), write: vi.fn(() => { throw new Error("disk full"); }), fsync: vi.fn(), close: vi.fn(), rename: vi.fn(), unlink: vi.fn() } as never;
  expect(() => writeServerInstance(file, "C".repeat(22), failing)).toThrow("disk full");
  expect((failing as { rename: ReturnType<typeof vi.fn> }).rename).not.toHaveBeenCalled();
  expect((failing as { unlink: ReturnType<typeof vi.fn> }).unlink).toHaveBeenCalled();
  expect(readFileSync(file, "utf8")).toBe(`${"A".repeat(22)}\n`);
});
it("r7 a leftover temp file from a crashed earlier process does not block the next write", () => {
  const file = join(dir, ".server-instance");
  writeFileSync(join(dir, `.server-instance.${process.pid}.tmp`), "stale");
  writeServerInstance(file, "D".repeat(22));
  expect(readFileSync(file, "utf8")).toBe(`${"D".repeat(22)}\n`);
});
it("r7 publishing happens once, on a Cloud home only, and a failure is not remembered as success", () => {
  const write = vi.fn();
  ensureServerInstancePublished({ MURAGE_CLOUD_ROLE: "" }, write); expect(write).not.toHaveBeenCalled();
  const env = { MURAGE_CLOUD_ROLE: "home" };
  write.mockImplementationOnce(() => { throw new Error("nope"); });
  expect(() => ensureServerInstancePublished(env, write)).toThrow("nope");
  ensureServerInstancePublished(env, write); ensureServerInstancePublished(env, write);
  expect(write).toHaveBeenCalledTimes(2);
  mkdirSync(join(dir, "unused"));
});
