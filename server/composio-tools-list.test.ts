// The standard session tools Murage serves to a first mount before the
// connection service answers (composio.ts STANDARD_SESSION_TOOLS) carry the
// service's real input schemas: checked here against the calls Murage's own
// flows and bots make, and against the shapes that must not pass.
import { describe, expect, it } from "vitest";

import { STANDARD_SESSION_TOOLS } from "./composio.ts";

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; minItems?: number; enum?: unknown[] };

/** The JSON Schema subset these schemas use: type, properties, required, items, minItems, enum. */
function validate(schema: Schema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && schema.type !== kind) return [`${path}: expected ${schema.type}, got ${kind}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not one of ${schema.enum.join(", ")}`);
  if (schema.type === "object" && value && typeof value === "object") {
    for (const key of schema.required ?? []) if (!(key in (value as object))) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in (value as object)) errors.push(...validate(child, (value as Record<string, unknown>)[key], `${path}.${key}`));
    }
  }
  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validate(schema.items!, item, `${path}[${index}]`)));
  }
  return errors;
}

const schemaOf = (name: string): Schema => {
  const tool = STANDARD_SESSION_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no ${name}`);
  return tool.inputSchema as Schema;
};

describe("the bundled session tool schemas", () => {
  it("lists the four session tools, each with a real object schema", () => {
    expect(STANDARD_SESSION_TOOLS.map((tool) => tool.name)).toEqual([
      "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS",
    ]);
    for (const tool of STANDARD_SESSION_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema).not.toHaveProperty("additionalProperties", true);
      expect((tool.inputSchema.required as string[]).length).toBeGreaterThan(0);
      expect(tool.description).not.toMatch(/composio|—|\bsafe|safety|unsafe/i);
    }
  });

  it("accepts the calls Murage's flows make", () => {
    expect(validate(schemaOf("COMPOSIO_SEARCH_TOOLS"), { queries: [{ use_case: "send mail" }], session: { generate_id: true } })).toEqual([]);
    expect(validate(schemaOf("COMPOSIO_SEARCH_TOOLS"), { queries: [{ use_case: "send an email to Ana", known_fields: "to:ana@example.com" }], session: { generate_id: true } })).toEqual([]);
    expect(validate(schemaOf("COMPOSIO_GET_TOOL_SCHEMAS"), { tool_slugs: ["GMAIL_SEND_EMAIL"] })).toEqual([]);
    expect(validate(schemaOf("COMPOSIO_MULTI_EXECUTE_TOOL"), { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "ana@example.com" } }], sync_response_to_workbench: false })).toEqual([]);
    expect(validate(schemaOf("COMPOSIO_MANAGE_CONNECTIONS"), { toolkits: ["gmail"] })).toEqual([]);
  });

  it("requires what the published contract requires (execute needs sync_response_to_workbench, search needs a session)", () => {
    expect(schemaOf("COMPOSIO_MULTI_EXECUTE_TOOL").required).toEqual(["tools", "sync_response_to_workbench"]);
    expect(validate(schemaOf("COMPOSIO_MULTI_EXECUTE_TOOL"), { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }] })).toContain("$.sync_response_to_workbench: required");
    expect(schemaOf("COMPOSIO_SEARCH_TOOLS").required).toEqual(["queries", "session"]);
    expect(validate(schemaOf("COMPOSIO_SEARCH_TOOLS"), { queries: [{ use_case: "send mail" }] })).toContain("$.session: required");
    expect(schemaOf("COMPOSIO_GET_TOOL_SCHEMAS").required).toEqual(["tool_slugs"]);
    expect(schemaOf("COMPOSIO_MANAGE_CONNECTIONS").required).toEqual(["toolkits"]);
  });

  it("refuses empty or guessed arguments", () => {
    expect(validate(schemaOf("COMPOSIO_SEARCH_TOOLS"), {})).not.toEqual([]);
    expect(validate(schemaOf("COMPOSIO_SEARCH_TOOLS"), { query: "send mail" })).not.toEqual([]);
    expect(validate(schemaOf("COMPOSIO_SEARCH_TOOLS"), { queries: "send mail" })).not.toEqual([]);
    expect(validate(schemaOf("COMPOSIO_SEARCH_TOOLS"), { queries: [] })).not.toEqual([]);
    expect(validate(schemaOf("COMPOSIO_SEARCH_TOOLS"), { queries: [{ query: "send mail" }] })).not.toEqual([]);
    expect(validate(schemaOf("COMPOSIO_MULTI_EXECUTE_TOOL"), { tools: [{ slug: "GMAIL_SEND_EMAIL" }] })).not.toEqual([]);
    expect(validate(schemaOf("COMPOSIO_GET_TOOL_SCHEMAS"), {})).not.toEqual([]);
    expect(validate(schemaOf("COMPOSIO_MANAGE_CONNECTIONS"), { toolkit: "gmail" })).not.toEqual([]);
  });
});
