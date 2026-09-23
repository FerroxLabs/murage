// The queued-messages mirror holds the person's own unsent words. Upstream
// #1620 made the data folder's records owner only; this one was left 0644.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { tightenOwnerOnlyFile } from "./atomic.ts";
import { writeSteerQueueMirror } from "./steer-queue.ts";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });

it.skipIf(process.platform === "win32")("writes the queued-messages mirror owner only and removes it when the queue empties", () => {
  root = mkdtempSync(join(tmpdir(), "murage-steer-mirror-"));
  const file = join(root, "queued-messages.json");
  writeSteerQueueMirror(file, [["thread", { botId: "bot", items: [{ messageId: "m", text: "private words", prompt: "private words" }] }]]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8"))[0][1].items[0].text).toBe("private words");
  writeSteerQueueMirror(file, []);
  expect(existsSync(file)).toBe(false);
});

it.skipIf(process.platform === "win32")("tightens a loose owner file and leaves a private or missing one alone", () => {
  root = mkdtempSync(join(tmpdir(), "murage-owner-file-"));
  const file = join(root, "bots.json");
  writeFileSync(file, "[]"); chmodSync(file, 0o644);
  expect(tightenOwnerOnlyFile(file)).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(tightenOwnerOnlyFile(file)).toBe(false);
  expect(tightenOwnerOnlyFile(join(root, "missing.json"))).toBe(false);
});

it("never touches modes on Windows", () => {
  root = mkdtempSync(join(tmpdir(), "murage-owner-file-"));
  const file = join(root, "bots.json");
  writeFileSync(file, "[]"); chmodSync(file, 0o644);
  expect(tightenOwnerOnlyFile(file, "win32")).toBe(false);
});

it.skipIf(process.platform === "win32")("leaves a directory or link in a record's place for recovery to report", () => {
  root = mkdtempSync(join(tmpdir(), "murage-owner-file-"));
  const directory = join(root, "bots.json");
  mkdirSync(directory); chmodSync(directory, 0o755);
  expect(tightenOwnerOnlyFile(directory)).toBe(false);
  expect(statSync(directory).mode & 0o777).toBe(0o755);
  const target = join(root, "elsewhere.json"), link = join(root, "groups.json");
  writeFileSync(target, "[]"); chmodSync(target, 0o644); symlinkSync(target, link);
  expect(tightenOwnerOnlyFile(link)).toBe(false);
  expect(statSync(target).mode & 0o777).toBe(0o644);
});
