// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Rules 67 and 68c, structurally: no driver hands an engine an allow except through its turn's refusal, and the hook's
// liveness is set in one place only. A bypass anywhere in these files fails here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const DRIVERS = ["codex.ts", "codex-hook.ts", "claude.ts", "pi.ts", "acp/core.ts"];
const read = (file: string) => readFileSync(join(here, file), "utf8");
/** Lines with a comment stripped, numbered from 1. */
const linesOf = (text: string) => text.split("\n").map((line, i) => ({ n: i + 1, code: line.replace(/\/\/.*$/, "") }));

/** An allow ANSWER: an object literal value, never a type (`"allow" |`, `"allow";`). */
const ALLOW_ANSWER = /\b(decision|behavior)\s*:\s*"allow"\s*[,}]/g;

describe("turn-refusal structure", () => {
  it("has no literal allow answer outside refusal.allow(...) in any driver", () => {
    const bypasses: string[] = [];
    for (const file of DRIVERS) {
      for (const { n, code } of linesOf(read(file))) {
        for (const match of code.matchAll(ALLOW_ANSWER)) {
          const opener = code.lastIndexOf("refusal.allow(", match.index);
          if (opener < 0) bypasses.push(`${file}:${n}: ${code.trim()}`);
        }
      }
    }
    expect(bypasses).toEqual([]);
  });

  it("sets hookLive only inside TurnRefusal.acceptProof", () => {
    const LIVE = /hookLive\s*=\s*true/;
    for (const file of DRIVERS) {
      expect(linesOf(read(file)).filter(({ code }) => LIVE.test(code)).map(({ n }) => `${file}:${n}`)).toEqual([]);
    }
    const own = read("turn-refusal.ts");
    const start = own.indexOf("acceptProof(): boolean {");
    expect(start).toBeGreaterThan(0);
    const end = own.indexOf("\n  }", start);
    const outside = own.slice(0, start) + own.slice(end);
    expect(LIVE.test(outside)).toBe(false);
    expect(LIVE.test(own.slice(start, end))).toBe(true);
  });

  it("asks the refusal first on every Codex path that can answer or settle", () => {
    const codex = read("codex.ts");
    const firstLines = (marker: string, count: number) => {
      const at = codex.indexOf(marker);
      expect(at, marker).toBeGreaterThan(0);
      // the first statements of the body, comment lines skipped
      return codex.slice(at).split("\n").slice(1).filter((line) => !line.trim().startsWith("//")).slice(0, count).join("\n");
    };
    expect(firstLines("const onPreTool = async (delivery: HookDelivery): Promise<HookAnswer> => {", 1)).toMatch(/refusal\./);
    expect(firstLines("const handleServerRequest = (msg: any) => {", 1)).toMatch(/refusal\./);
    expect(firstLines("const settle = async (ok: boolean, stopReason: string | null): Promise<void> => {", 3)).toMatch(/refusal\.refused/);
    expect(firstLines('case "item/started": {', 2)).toMatch(/refusal\.noteStarted\(\)/);
    // every card's finish turns a late allow into a deny before anything else
    const finishes = [...codex.matchAll(/const finish: AskFinish = \([^)]*\) => \{\n(.*)\n/g)];
    expect(finishes.length).toBeGreaterThanOrEqual(2);
    for (const finish of finishes) expect(finish[1]).toMatch(/refusal\.verdict\(/);
    // the turn's refusal is one per turn, made where the hook table is
    expect(codex.match(/new TurnRefusal\(/g)).toHaveLength(1);
  });
});
