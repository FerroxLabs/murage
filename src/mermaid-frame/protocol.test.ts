import { describe, expect, it } from "vitest";
import { MAX_DIAGRAM_SOURCE, MAX_FRAME_HEIGHT, MIN_FRAME_HEIGHT, parseFrameMessage, parseRenderRequest } from "./protocol";

describe("frame → app messages", () => {
  it("accepts only the three shapes, exactly", () => {
    expect(parseFrameMessage({ type: "murage-mermaid:ready" })).toEqual({ type: "murage-mermaid:ready" });
    expect(parseFrameMessage({ type: "murage-mermaid:rendered", id: 3, height: 120.2 })).toEqual({ type: "murage-mermaid:rendered", id: 3, height: 121 });
    expect(parseFrameMessage({ type: "murage-mermaid:error", id: 3, reason: "parse" })).toEqual({ type: "murage-mermaid:error", id: 3, reason: "parse" });
    for (const bad of [
      null, "murage-mermaid:ready", [], { type: "murage-mermaid:ready", extra: 1 },
      { type: "murage-mermaid:rendered", id: 3, height: 10, html: "<svg>" },
      { type: "murage-mermaid:rendered", id: -1, height: 10 },
      { type: "murage-mermaid:rendered", id: 1.5, height: 10 },
      { type: "murage-mermaid:rendered", id: 1, height: Number.NaN },
      { type: "murage-mermaid:rendered", id: 1, height: "10" },
      { type: "murage-mermaid:error", id: 1, reason: "<img src=x onerror=alert(1)>" },
      { type: "murage-mermaid:navigate", id: 1 },
      Object.assign(Object.create({ inherited: true }), { type: "murage-mermaid:ready" }),
    ]) expect(parseFrameMessage(bad)).toBeNull();
  });
  it("bounds the height", () => {
    expect(parseFrameMessage({ type: "murage-mermaid:rendered", id: 1, height: 1e9 })).toMatchObject({ height: MAX_FRAME_HEIGHT });
    expect(parseFrameMessage({ type: "murage-mermaid:rendered", id: 1, height: -50 })).toMatchObject({ height: MIN_FRAME_HEIGHT });
    expect(parseFrameMessage({ type: "murage-mermaid:rendered", id: 1, height: Infinity })).toBeNull();
  });
});

describe("app → frame messages", () => {
  it("accepts a well-formed render request only", () => {
    expect(parseRenderRequest({ type: "murage-mermaid:render", id: 1, source: "graph TD; A-->B", theme: "light" })).toEqual({ type: "murage-mermaid:render", id: 1, source: "graph TD; A-->B", theme: "light" });
    for (const bad of [
      { type: "murage-mermaid:render", id: 1, source: "x", theme: "neon" },
      { type: "murage-mermaid:render", id: 1, source: 5, theme: "dark" },
      { type: "murage-mermaid:render", id: 1, source: "x".repeat(MAX_DIAGRAM_SOURCE + 1), theme: "dark" },
      { type: "murage-mermaid:render", id: 1, source: "x", theme: "dark", config: { securityLevel: "loose" } },
      { type: "murage-mermaid:render", source: "x", theme: "dark" },
    ]) expect(parseRenderRequest(bad)).toBeNull();
  });
});
