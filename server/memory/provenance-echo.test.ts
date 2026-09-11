import { describe, expect, it } from "vitest";
import { isMemoryProvenanceEcho } from "./provenance-echo.ts";

describe("memory provenance echo (MEMJSON1)", () => {
  it("recognises the reply observed in smoke round 1 and other provenance-only replies", () => {
    expect(isMemoryProvenanceEcho('{"sourceId":"message:reply","revision":1,"startByte":0,"endByte":4}')).toBe(true);
    expect(isMemoryProvenanceEcho('  [{"sourceId":"message:a:b","revision":1,"startByte":0,"endByte":65},{"sourceId":"message:a:c","revision":2,"startByte":3,"endByte":17}]\n')).toBe(true);
    expect(isMemoryProvenanceEcho('```json\n{"sourceId":"s","revision":1,"startByte":0,"endByte":4}\n```')).toBe(true);
    // The 0.1.51 reference record shape copied whole.
    expect(isMemoryProvenanceEcho(JSON.stringify([{ id: "checkpoint:9c2b", version: 3, scopeId: "scope", text: "Working evidence", assertion: "assistant-inference", pinned: false, kind: "checkpoint",
      evidence: [{ sourceId: "message:t:m", revision: 1, startByte: 0, endByte: 65 }] }]))).toBe(true);
  });

  it("leaves ordinary replies alone, including prose that quotes provenance", () => {
    for (const reply of [
      "pong",
      "",
      "{}",
      "[]",
      '{"ok":true}',
      '[{"id":"x","text":"not a memory record"}]',
      'Here is the handle: {"sourceId":"s","revision":1,"startByte":0,"endByte":4}',
      '{"sourceId":"s","revision":1,"startByte":0,"endByte":4,"answer":"pong"}',
      '{"sourceId":1,"startByte":0,"endByte":4}',
      '[{"sourceId":"s","revision":1,"startByte":0,"endByte":4},"pong"]',
      "{not json",
    ]) expect(isMemoryProvenanceEcho(reply), reply).toBe(false);
  });

  it("does not parse oversized replies", () => {
    const handle = { sourceId: "s", revision: 1, startByte: 0, endByte: 4 };
    expect(isMemoryProvenanceEcho(JSON.stringify(Array.from({ length: 2000 }, () => handle)))).toBe(false);
  });
});
