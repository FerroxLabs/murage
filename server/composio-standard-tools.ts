// The connected-app session's standard tools, bundled. Plain data with no imports:
// the connector bridge process (connector-proxy.ts) serves it when the upstream
// is too slow to list tools, so it must stay light to load.

/** The connected-app session's standard tools, for a first mount whose broker
 * is slow to answer. Their input schemas are the connection service's own
 * published ones for these session tools (docs.composio.dev, toolkits/
 * meta-tools: search_tools, get_tool_schemas, multi_execute_tool,
 * manage_connections, read 2026-10-10), checked by composio-tools-list.test.ts
 * against the calls Murage's own flows make: so a first mount gets the real
 * argument structure (search takes `queries: [{use_case}]`), `{}` or a guessed
 * shape does not pass, and the broker still checks every call. The real list
 * replaces this one as soon as it arrives (PROVISIONAL_TOOLS_META). */
export const STANDARD_SESSION_TOOLS: ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: "COMPOSIO_SEARCH_TOOLS",
    description: "Find the right tools for a task across the user's connected apps, with their input schemas, an execution plan and the account each one uses.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          minItems: 1,
          description: "One entry per use case in the task.",
          items: {
            type: "object",
            properties: {
              use_case: { type: "string", description: "A normalized English description of the complete use case, to plan it precisely." },
              known_fields: { type: "string", description: "Comma-separated key:value pairs of inputs already known for the workflow." },
            },
            required: ["use_case"],
          },
        },
        session: {
          type: "object",
          properties: {
            id: { type: "string", description: "An existing session id from an earlier search." },
            generate_id: { type: "boolean", description: "True for a new workflow." },
          },
          anyOf: [{ required: ["id"] }, { required: ["generate_id"] }],
          description: "Required: an existing session id, or generate_id true for a new workflow.",
        },
        model: { type: "string", description: "The client model name, to tune the search." },
        search_strategy: { type: "string", enum: ["auto", "tool_search"], description: "auto (default), or tool_search to skip cached plans." },
      },
      required: ["queries", "session"],
    },
  },
  {
    name: "COMPOSIO_GET_TOOL_SCHEMAS",
    description: "Get the full input schemas for tools by their slugs.",
    inputSchema: {
      type: "object",
      properties: {
        tool_slugs: { type: "array", minItems: 1, items: { type: "string" }, description: "Valid tool slugs; never invent one." },
        include: { type: "array", items: { type: "string", enum: ["input_schema", "output_schema"] }, description: "Which schemas to return; default input_schema." },
        session_id: { type: "string", description: "The session id from an earlier search, when there is one." },
      },
      required: ["tool_slugs"],
    },
  },
  {
    name: "COMPOSIO_MULTI_EXECUTE_TOOL",
    description: "Run one or more connected-app tools by slug with their arguments, in parallel.",
    inputSchema: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          minItems: 1,
          description: "Logically independent tools to run in parallel.",
          items: {
            type: "object",
            properties: {
              tool_slug: { type: "string", description: "The slug of the tool to run; must be a valid slug, never invented." },
              arguments: { type: "object", description: "Arguments matching that tool's exact schema." },
            },
            required: ["tool_slug", "arguments"],
          },
        },
        sync_response_to_workbench: { type: "boolean", description: "Save large responses remotely instead of returning them whole." },
        thought: { type: "string", description: "A one-sentence reason for this step." },
        current_step: { type: "string", description: "The workflow step, for example FETCHING_EMAILS." },
        current_step_metric: { type: "string", description: "Progress as done/total units." },
        session_id: { type: "string", description: "The session id from an earlier search, when there is one." },
      },
      required: ["tools", "sync_response_to_workbench"],
    },
  },
  {
    name: "COMPOSIO_MANAGE_CONNECTIONS",
    description: "Connect an app the user has not connected yet: the user is shown a connection card.",
    inputSchema: {
      type: "object",
      properties: {
        toolkits: { type: "array", minItems: 1, items: { type: "string" }, description: "App slugs such as gmail, github or slack." },
        reinitiate_all: { type: "boolean", description: "Reconnect even apps that are already connected." },
        session_id: { type: "string", description: "The session id from an earlier search, when there is one." },
      },
      required: ["toolkits"],
    },
  },
];

