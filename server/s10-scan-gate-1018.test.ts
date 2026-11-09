// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 (S10, MurageMain's ruling 11-06): the outside scan does not read a text past 128 KiB, so that text marks the
// turn. Nothing is clean that was not read. Below the gate the scan reads as before.
import { describe, expect, it } from "vitest";
import { envSplitsReference, envSplitsTable, outsideScanMarks, SCAN_GATE_CHARS } from "./outside-scan.ts";

const plain = (chars: number) => "echo a\n".repeat(Math.floor(chars / 7));

describe("the scan's 128 KiB gate", () => {
  it("sits at 128 KiB, the same as auto-approve.ts COMMAND_GATE_CHARS", () => {
    expect(SCAN_GATE_CHARS).toBe(128 * 1024);
  });

  it("marks a plain text past the gate", () => {
    const long = plain(SCAN_GATE_CHARS + 2048);
    expect(long.length).toBeGreaterThan(SCAN_GATE_CHARS);
    expect(outsideScanMarks(long)).toEqual(["interpreter", "downloaded file", "cloned folder", "network command", "package install", "git", "archive"]);
  });

  it("reads many `env` words in one segment in linear time, under 500 ms just below the gate", () => {
    for (const unit of ["env ", "$env:a "]) {
      for (const chars of [64 * 1024, SCAN_GATE_CHARS - 1024]) {
        const text = unit.repeat(Math.floor(chars / unit.length));
        const start = performance.now();
        outsideScanMarks(text);
        expect(performance.now() - start).toBeLessThan(500);
      }
    }
  });

  it("reads many `-env` option words in linear time, under 500 ms just below the gate (Astra r7 #3)", () => {
    for (const chars of [64 * 1024, SCAN_GATE_CHARS - 1024]) {
      const text = "echo " + "-env ".repeat(Math.floor((chars - 5) / 5));
      const start = performance.now();
      outsideScanMarks(text);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  it("the one-pass env option table gives the word-at-a-time answer at every index", () => {
    const WORDS = ["--", "--s", "--split-string=x", "--u", "--unset", "--unset=A", "--ch", "--chdir=a", "--i", "-s", "-u", "-c", "-uc", "-cu", "-us", "-su", "-i", "-vS", "-", "a=1", "ls", "-x", "NAME", "env", "-env"];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    let checked = 0;
    for (let n = 0; n < 3000; n++) {
      const segment = Array.from({ length: next() % 14 }, () => WORDS[next() % WORDS.length]!);
      const table = envSplitsTable(segment);
      for (let index = 0; index < segment.length; index++) {
        expect(table[index + 1] === 1, JSON.stringify({ segment, index })).toBe(envSplitsReference(segment, index));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("still marks `env -S` past other env words and options", () => {
    expect(outsideScanMarks("env env -S 'echo hi'")).toContain("interpreter");
    expect(outsideScanMarks("env -u NAME -S 'echo hi'")).toContain("interpreter");
    expect(outsideScanMarks("env env --split-string='echo hi'")).toContain("interpreter");
  });

  it("leaves the same plain text clean below the gate", () => {
    expect(outsideScanMarks(plain(SCAN_GATE_CHARS - 2048))).toEqual([]);
  });
});
