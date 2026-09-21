import { describe, expect, it } from "vitest";
import { extractMcpImages, screenSurfaceTool, MCP_TOOL_IMAGE_LIMIT } from "./mcp-tool-images.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("extractMcpImages", () => {
  it("pulls MCP-native image blocks out of a content array, ignoring text", () => {
    expect(extractMcpImages([{ type: "text", text: "ok" }, { type: "image", data: png, mimeType: "image/png" }]))
      .toEqual([{ data: png, mimeType: "image/png" }]);
  });

  it("pulls image blocks out of a { content: [...] } result wrapper", () => {
    expect(extractMcpImages({ content: [{ type: "image", data: "xyz", mimeType: "image/jpeg" }], isError: false }))
      .toEqual([{ data: "xyz", mimeType: "image/jpeg" }]);
  });

  it("normalizes the Anthropic Messages shape the Claude CLI rewrites tool_result images into", () => {
    expect(extractMcpImages([
      { type: "text", text: "ok" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "def456" } },
    ])).toEqual([{ data: "def456", mimeType: "image/jpeg" }]);
  });

  it("unwraps ACP's {type:'content'} tool-output parts", () => {
    expect(extractMcpImages([
      { type: "content", content: { type: "text", text: "ok" } },
      { type: "content", content: { type: "image", data: png, mimeType: "image/png" } },
    ])).toEqual([{ data: png, mimeType: "image/png" }]);
  });

  it("returns [] for text-only, missing, or malformed input", () => {
    expect(extractMcpImages([{ type: "text", text: "ok" }])).toEqual([]);
    expect(extractMcpImages(undefined)).toEqual([]);
    expect(extractMcpImages({ content: [{ type: "image", data: 5, mimeType: "image/png" }] })).toEqual([]);
    expect(extractMcpImages([{ type: "image", data: "  ", mimeType: "image/png" }])).toEqual([]);
    expect(extractMcpImages([{ type: "image", data: png, mimeType: "text/html" }])).toEqual([]);
    expect(extractMcpImages([{ type: "image", source: { type: "url", media_type: "image/png", data: png } }])).toEqual([]);
  });

  // Each survivor becomes a file in the managed output root and a permanent
  // Files row, so a tool answering with an album is a retention event.
  it("keeps at most MCP_TOOL_IMAGE_LIMIT images from one result", () => {
    const many = Array.from({ length: MCP_TOOL_IMAGE_LIMIT + 6 }, (_, n) => ({ type: "image", data: `d${n}`, mimeType: "image/png" }));
    const kept = extractMcpImages(many);
    expect(kept).toHaveLength(MCP_TOOL_IMAGE_LIMIT);
    expect(kept.map(image => image.data)).toEqual(["d0", "d1", "d2", "d3"]);
  });

  it("drops images from Murage's own screen surfaces, which are previews and not deliverables", () => {
    const content = [{ type: "image", data: png, mimeType: "image/png" }];
    for (const tool of ["mcp__computer__screenshot", "computer__click", "browser_screenshot", "mcp__browser__browser_screenshot", "screenshot", "computer_click", "mcp__phone__screenshot", "murage_phone__screenshot"]) {
      expect(extractMcpImages(content, tool), tool).toEqual([]);
    }
  });

  it("keeps an image from a custom MCP server even when its tool is called screenshot", () => {
    const content = [{ type: "image", data: png, mimeType: "image/png" }];
    expect(extractMcpImages(content, "mcp__omarchy-bridge__screenshot")).toEqual([{ data: png, mimeType: "image/png" }]);
    expect(extractMcpImages(content, "omarchy__take_screenshot")).toEqual([{ data: png, mimeType: "image/png" }]);
    expect(extractMcpImages(content, "render_chart")).toEqual([{ data: png, mimeType: "image/png" }]);
  });
});

describe("screenSurfaceTool", () => {
  it("decides a qualified name by its server alone", () => {
    expect(screenSurfaceTool("mcp__computer__anything_at_all")).toBe(true);
    expect(screenSurfaceTool("mcp__murage-memory__memory_search")).toBe(false);
    // The harness server keys are reserved in server/mcp-registry.ts, so a
    // custom server cannot claim one to have its output dropped.
    expect(screenSurfaceTool("mcp__notcomputer__screenshot")).toBe(false);
  });

  it("falls back to the surface's bare tool names for drivers that send an unqualified leaf", () => {
    expect(screenSurfaceTool("click")).toBe(true);
    expect(screenSurfaceTool("browser_navigate")).toBe(true);
    expect(screenSurfaceTool("read_screen")).toBe(true);
    expect(screenSurfaceTool("double_click")).toBe(true);
    expect(screenSurfaceTool("generate_diagram")).toBe(false);
    expect(screenSurfaceTool("")).toBe(false);
  });
});
