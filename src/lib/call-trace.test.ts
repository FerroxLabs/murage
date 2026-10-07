import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { callTrace, formatCallTrace } from "./call-trace";

describe("call trace", () => {
  it("writes a label with numeric and boolean fields", () => {
    expect(formatCallTrace("hold send", { chars: 12, afterMs: 410, waited: true })).toBe("[call-trace] hold send chars=12 afterMs=410 waited=true");
  });

  it("drops any text field, so no transcript can reach the log", () => {
    const sneaky = { chars: 5, said: "what is the weather in Austin" } as unknown as Record<string, number>;
    const line = formatCallTrace("send", sneaky) ?? "";
    expect(line).toBe("[call-trace] send chars=5");
    expect(line).not.toMatch(/weather|Austin/);
  });

  it("refuses a label that carries free text", () => {
    expect(formatCallTrace("What is the weather in Austin?")).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    callTrace("Hello, Sable. Remind me at 5", { chars: 3 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("no [call-diag] or [call-trace] emit carries transcript text (M5)", () => {
  const WORDY = /(?<!evidence\.)\b(text|said|heard|transcript|shown|words|line)\b/;
  const COUNT = /\.length\b|wordCount\(|\.toFixed\(|\.speech\b|\.partial\b|\.error\b|longEndpoint/;

  /** The `${...}` expressions of every line that holds a diag/trace marker. */
  function interpolations(src: string, marker: RegExp = /\[call-(diag|trace)\]/): string[] {
    const out: string[] = [];
    for (const row of src.split("\n")) {
      if (!marker.test(row)) continue;
      for (let i = row.indexOf("${"); i !== -1; i = row.indexOf("${", i + 2)) {
        let depth = 1;
        let j = i + 2;
        for (; j < row.length && depth; j++) {
          if (row[j] === "{") depth++;
          else if (row[j] === "}") depth--;
        }
        out.push(row.slice(i + 2, j - 1));
      }
    }
    return out;
  }
  const leaks = (src: string, marker?: RegExp) => interpolations(src, marker).filter((e) => {
    const bare = e.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
    return WORDY.test(bare) && !COUNT.test(bare);
  });

  it("the checker flags an interpolated transcript", () => {
    expect(leaks("console.warn(`[call-diag] heard ${line.text}`);")).toHaveLength(1);
    expect(leaks("console.warn(`[call-diag] said ${said}`);")).toHaveLength(1);
    expect(leaks("console.warn(`[call-diag] ${wordCount(said)}w ${said.length} chars`);")).toHaveLength(0);
  });

  it("holds for every emitter in src and electron", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "node_modules" && name !== "resources") walk(full);
        } else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(full);
      }
    };
    const root = path.resolve(__dirname, "../..");
    walk(path.join(root, "src"));
    walk(path.join(root, "electron"));
    const emitters = files.filter((f) => /\[call-(diag|trace)\]/.test(readFileSync(f, "utf8")));
    expect(emitters.length).toBeGreaterThanOrEqual(5);
    for (const f of emitters) expect(leaks(readFileSync(f, "utf8")), path.relative(root, f)).toEqual([]);
  });

  it("the server's timing lines carry numbers only too", () => {
    const root = path.resolve(__dirname, "../..");
    const marker = /\[(tts|voice-host)\]|headers \$\{/;
    expect(leaks("console.log(`[tts] speak timing: ${text}`);", marker)).toHaveLength(1);
    // the client builders spread one line over many array rows
    const rows = /->|piece=|player=|path=|ack=|total /;
    for (const f of ["src/lib/call-turns.ts", "src/lib/group-call-stream.ts"]) {
      const src = readFileSync(path.join(root, f), "utf8");
      expect(interpolations(src, rows).length, f).toBeGreaterThan(5);
      expect(leaks(src, rows), f).toEqual([]);
    }
    expect(leaks("`piece=${said}`", /piece=/)).toHaveLength(1);
    for (const f of ["server/tts/index.ts", "server/voice/voice-host-route.ts"]) {
      const src = readFileSync(path.join(root, f), "utf8");
      expect(interpolations(src, marker).length, f).toBeGreaterThan(0);
      expect(leaks(src, marker), f).toEqual([]);
    }
  });
});
