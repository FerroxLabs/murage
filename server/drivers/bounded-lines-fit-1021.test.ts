// 1.0.21 group B (cause22-eng-design3-fable/DESIGN.md A1-A4, U0-U3; owner lane cause22-eng): a stdout line of any size never
// throws from the splitter. A line a string can hold (counted in UTF-16 units, as String.length counts) arrives whole; a longer one
// is fitted (its long strings cut, its JSON shape kept) and handed to onFit. The U1 rows use the runtime's REAL limit.
import { constants } from "node:buffer";
import { describe, expect, it } from "vitest";

import { createBoundedLineSplitter, type LineFit } from "./bounded-lines.ts";

/** The runtime's own limit (node 22: 536,870,888 units); this file imports nothing else from the fix, so it runs on the base too. */
const LINE_UNIT_LIMIT = constants.MAX_STRING_LENGTH;

const MiB = 1024 * 1024;
const collect = () => {
  const lines: string[] = [];
  const fits: Array<{ line: string; fit: LineFit }> = [];
  const splitter = createBoundedLineSplitter({ onLine: (line) => lines.push(line), onFit: (line, fit) => fits.push({ line, fit }) });
  return { splitter, lines, fits };
};
/** Push `total` bytes made of `unit` repeated, in 64 MiB reads, then optionally a newline; any throw is returned, not raised. */
const pushRepeated = (push: (b: Buffer) => void, unit: Buffer, total: number): unknown => {
  const block = Buffer.alloc(64 * MiB - ((64 * MiB) % unit.length), unit);
  try {
    for (let sent = 0; sent < total;) { const n = Math.min(block.length, total - sent); push(block.subarray(0, n)); sent += n; }
  } catch (error) { return error; }
  return undefined;
};

describe("U0 the decoded line is exactly Buffer.toString of its bytes, however it is chunked", () => {
  it("random byte lines (valid, 0xFF runs, stray 0x80 runs, cut sequences, split surrogates) x random chunking", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const parts = [Buffer.from("é€😀a"), Buffer.from([0xff, 0xff]), Buffer.from([0x80, 0x80, 0x80]), Buffer.from([0xf0, 0x9f]), Buffer.from([0xe2, 0x82]), Buffer.from("{\"k\":\"v\"}")];
    for (let round = 0; round < 300; round++) {
      const line = Buffer.concat(Array.from({ length: 1 + rnd(12) }, () => parts[rnd(parts.length)]!));
      const wire = Buffer.concat([line, Buffer.from("\n")]);
      const { splitter, lines } = collect();
      for (let at = 0; at < wire.length;) { const n = 1 + rnd(5); splitter.push(wire.subarray(at, at + n)); at += n; }
      expect(lines).toEqual([line.toString("utf8")]);
    }
  });
});

describe("U1 the runtime's real string limit", () => {
  it("Opus r9 H1: a non-JSON line of separators and digits past the limit is fitted under the limit, never thrown", () => {
    const { splitter, lines, fits } = collect();
    let thrown = pushRepeated((b) => splitter.push(b), Buffer.from("1,"), LINE_UNIT_LIMIT + 2);
    try { if (!thrown) splitter.push(Buffer.from("\n")); } catch (error) { thrown = error; }
    expect(String(thrown ?? "no throw")).toBe("no throw");
    expect(lines).toHaveLength(0);
    expect(fits).toHaveLength(1);
    expect(fits[0]!.line.length).toBeLessThanOrEqual(LINE_UNIT_LIMIT);
  });
  it("a multibyte line of more bytes than the limit but fewer units arrives whole (no throw)", () => {
    const { splitter, lines, fits } = collect();
    const e = Buffer.from("é");
    const bytes = LINE_UNIT_LIMIT + 2 * MiB; // > LIMIT bytes, (LIMIT + 2 MiB) / 2 units
    const thrown = pushRepeated((b) => splitter.push(b), e, bytes) ?? (() => { try { splitter.push(Buffer.from("\n{\"after\":1}\n")); } catch (error) { return error; } return undefined; })();
    expect(String(thrown ?? "no throw")).toBe("no throw");
    expect(fits).toHaveLength(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.length).toBe(bytes / 2);
    expect(lines[0]!.startsWith("éé") && lines[0]!.endsWith("éé")).toBe(true);
    expect(lines[1]).toBe("{\"after\":1}");
  });
  it("a JSON line of LIMIT + 1 units is fitted: shape and keys kept, its long string cut with a marker, the next line intact", () => {
    const { splitter, lines, fits } = collect();
    const head = Buffer.from("{\"id\":7,\"text\":\"");
    const tail = Buffer.from("\",\"stopReason\":\"end_turn\"}");
    const fill = LINE_UNIT_LIMIT + 1 - head.length - tail.length;
    let thrown: unknown;
    try { splitter.push(head); } catch (error) { thrown = error; }
    thrown ??= pushRepeated((b) => splitter.push(b), Buffer.from("x"), fill);
    try { if (!thrown) splitter.push(Buffer.concat([tail, Buffer.from("\n{\"next\":true}\n")])); } catch (error) { thrown = error; }
    expect(String(thrown ?? "no throw")).toBe("no throw");
    expect(fits).toHaveLength(1);
    expect(fits[0]!.fit).toEqual({ units: LINE_UNIT_LIMIT + 1, limit: LINE_UNIT_LIMIT });
    const msg = JSON.parse(fits[0]!.line);
    expect(Object.keys(msg)).toEqual(["id", "text", "stopReason"]);
    expect(msg.id).toBe(7);
    expect(msg.stopReason).toBe("end_turn");
    expect(msg.text.startsWith("x".repeat(MiB) + " …[cut ")).toBe(true);
    expect(lines).toEqual(["{\"next\":true}"]);
  });
  it("3 x LIMIT bytes of stray continuation bytes with no newline never throw and are fitted when the newline comes", () => {
    const { splitter, lines, fits } = collect();
    const thrown = pushRepeated((b) => splitter.push(b), Buffer.from([0x80]), LINE_UNIT_LIMIT + 8 * MiB)
      ?? pushRepeated((b) => splitter.push(b), Buffer.from([0x80]), 2 * LINE_UNIT_LIMIT);
    let after: unknown;
    try { splitter.push(Buffer.from("\n")); } catch (error) { after = error; }
    expect(String(thrown ?? after ?? "no throw")).toBe("no throw");
    expect(lines).toHaveLength(0);
    expect(fits).toHaveLength(1);
    expect(fits[0]!.fit.units).toBe(3 * LINE_UNIT_LIMIT + 8 * MiB);
    expect(fits[0]!.line.length).toBeLessThanOrEqual(8192);
  });
});

