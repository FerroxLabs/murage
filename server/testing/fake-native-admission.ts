// Differential fixture for a CLI-owned final hook / Pi gate return. Called
// only after the fake engine receives its prompt, never by catalog probes.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export function recordNativeAdmissionAnswer(): void {
  const destination = process.env.FAKE_NATIVE_ANSWER;
  if (!destination) return;
  const engine = process.env.FAKE_NATIVE_ENGINE;
  const variant = process.env.FAKE_NATIVE_VARIANT;
  const extension = engine === "pi" && variant?.startsWith("Pi MCP");
  const source = extension ? `
    import extension, { StdioMcp } from ${JSON.stringify(new URL("../drivers/pi-mcp-extension.ts", import.meta.url).href)};
    import { writeFileSync } from 'node:fs';
    const variant = ${JSON.stringify(variant)};
    const config = process.env.FAKE_NATIVE_ANSWER + '.config';
    writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ['-e', ''], scope: 'custom' } } }));
    process.env.MURAGE_MCP_CONFIG = config;
    const tools = new Map(), handlers = new Map();
    let client;
    StdioMcp.prototype.init = async function() { client = this; };
    StdioMcp.prototype.listSettledTools = async () => [{ name: 'fixture', inputSchema: { type: 'object' } }];
    StdioMcp.prototype.listTools = async () => [];
    StdioMcp.prototype.callTool = async () => ({ isError: variant === 'Pi MCP error throw', content: [{ type: 'text', text: 'fixture outcome' }] });
    await extension({ registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { handlers.set(name, handler); } });
    if (variant === 'Pi MCP retired return') {
      client.onToolsListChanged();
      await new Promise(resolve => setImmediate(resolve));
    }
    try {
      const answer = await [...tools.values()][0].execute('fixture', {}, undefined, undefined,
        { ui: { confirm: async () => variant !== 'Pi MCP user denial' } });
      process.stdout.write(JSON.stringify({ returned: answer }));
    } catch (error) { process.stdout.write(JSON.stringify({ thrown: error.message })); }
    finally { handlers.get('session_shutdown')(); }
  ` : engine === "pi" ? `
    import gate from ${JSON.stringify(new URL("../drivers/pi-permission-gate.ts", import.meta.url).href)};
    import { writeFileSync } from 'node:fs';
    const handlers = new Map();
    process.env.MURAGE_PI_GATE = 'fixture';
    delete process.env.MURAGE_PI_GATE_ONLY;
    gate({ on(name, handler) { handlers.set(name, handler); } });
    const path = process.env.FAKE_NATIVE_ANSWER + '.txt';
    writeFileSync(path, 'fixture');
    const ctx = { get cwd() { ${variant === "Pi permission catch block" ? "throw new Error('fixture context');" : "return process.cwd();"} } };
    const answer = await handlers.get("tool_call")({ toolCallId: "fixture", toolName: "read", input: { path } }, ctx);
    process.stdout.write(JSON.stringify({ decision: answer === undefined ? 'silent-allow' : answer }));
  ` : process.env.FAKE_NATIVE_HOOK_SOURCE;
  if (!source) throw new Error("FIXTURE_HOOK_SOURCE_REQUIRED");
  const child = spawnSync(process.execPath, [...(engine === "pi" ? ["--input-type=module"] : []), "-e", source], {
    cwd: process.env.HOME,
    input: engine === "hermes" ? '{"tool_name":"terminal","tool_input":{"command":"echo fixture"}}'
      : '{"toolCall":{"name":"read_file","args":{}}}', encoding: "utf8",
  });
  if (child.status !== 0) throw new Error("FIXTURE_NATIVE_DID_NOT_ANSWER");
  writeFileSync(destination, JSON.stringify(JSON.parse(child.stdout)));
}
