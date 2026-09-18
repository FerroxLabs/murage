import { describe, expect, it } from "vitest";

import { bareToolName, resolveToolLabel, toolFailureSummary, toolFailureText } from "./tool-activity.ts";

describe("resolveToolLabel", () => {
  it("names the inner tool when the engine calls through a wrapper", () => {
    // Fuigo 1.0.20, verbatim off the wire
    expect(
      resolveToolLabel("use_tool", {
        tool_name: "murage-memory-d7c8757614b6a44bde59__memory_search",
        tool_input: { query: "sweep1 canary" },
      }),
    ).toEqual({ name: "memory_search", summary: "sweep1 canary" });
  });

  it("keeps a shell chip showing the command", () => {
    expect(resolveToolLabel("Bash", { command: "ls -la" })).toEqual({ name: "ls -la" });
  });

  it("leaves an ordinary tool call alone", () => {
    expect(resolveToolLabel("Read", { file_path: "/tmp/x" })).toEqual({ name: "Read" });
  });

  it("falls back to `tool` when the engine sends nothing usable", () => {
    expect(resolveToolLabel(undefined, undefined)).toEqual({ name: "tool" });
    expect(resolveToolLabel("", null)).toEqual({ name: "tool" });
    expect(resolveToolLabel(42, [1, 2])).toEqual({ name: "tool" });
  });

  it("gives a tool-search wrapper its query, since its name never changes", () => {
    expect(resolveToolLabel("search_tool", { variant: "SearchTool", scope: "mcp", query: "memory search", limit: 5 })).toEqual({
      name: "search_tool",
      summary: "memory search",
    });
  });

  it("labels an argument that is not obviously the point of the call", () => {
    expect(resolveToolLabel("use_tool", { tool_name: "files__move", tool_input: { destination: "/tmp/b" } })).toEqual({
      name: "move",
      summary: "destination: /tmp/b",
    });
  });

  it("keeps names and summaries short enough for one chip", () => {
    const label = resolveToolLabel("use_tool", { tool_name: `srv__${"x".repeat(200)}`, tool_input: { query: "y".repeat(400) } });
    expect(label.name.length).toBeLessThanOrEqual(80);
    expect(label.summary!.length).toBeLessThanOrEqual(80);
  });

  it("collapses newlines so a chip stays one line", () => {
    expect(resolveToolLabel("use_tool", { tool_name: "s__t", tool_input: { query: "a\n\nb" } }).summary).toBe("a b");
  });
});

describe("bareToolName", () => {
  it("drops the server a tool is mounted under", () => {
    expect(bareToolName("murage-memory-1f83c2b4__memory_search")).toBe("memory_search");
    expect(bareToolName("mcp__files__read")).toBe("read");
  });

  it("leaves an unqualified name intact", () => {
    expect(bareToolName("read_file")).toBe("read_file");
  });
});

describe("toolFailureText", () => {
  it("reads the reason out of ACP text content", () => {
    expect(
      toolFailureText({
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "Memory is not available for this turn." } }],
      }),
    ).toBe("Memory is not available for this turn.");
  });

  it("joins several content parts", () => {
    expect(
      toolFailureText({
        content: [
          { type: "content", content: { type: "text", text: "first" } },
          { type: "content", content: { type: "text", text: "second" } },
        ],
      }),
    ).toBe("first\n\nsecond");
  });

  it("digs the reason out of a nested provider result", () => {
    expect(
      toolFailureText({
        rawOutput: { type: "MCP", tool_name: "memory_search", output: { ErrorOutput: "MEMORY_REQUEST_FAILED" } },
      }),
    ).toBe("MEMORY_REQUEST_FAILED");
  });

  it("accepts a plain error string", () => {
    expect(toolFailureText({ error: "connection refused" })).toBe("connection refused");
  });

  it("reads an error object's message", () => {
    expect(toolFailureText({ rawOutput: { error: { message: "no such model" } } })).toBe("no such model");
  });

  it("says nothing when the engine said nothing", () => {
    expect(toolFailureText({ status: "failed" })).toBeUndefined();
    expect(toolFailureText({ content: [] })).toBeUndefined();
    expect(toolFailureText(undefined)).toBeUndefined();
  });

  it("bounds a runaway reason", () => {
    const detail = toolFailureText({ error: "x".repeat(20000) })!;
    expect(detail.length).toBeLessThanOrEqual(4002);
  });
});

describe("toolFailureSummary", () => {
  it("shows the first line and keeps the rest for the details block", () => {
    expect(toolFailureSummary("Memory is not available.\nstack frame one\nstack frame two")).toBe("Memory is not available.");
  });

  it("truncates a single very long line", () => {
    expect(toolFailureSummary("z".repeat(500)).length).toBeLessThanOrEqual(160);
  });
});
