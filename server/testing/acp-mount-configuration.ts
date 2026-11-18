import { fixtureSubmittedInput } from "./mcp-admission-fixture.ts";
import { fixtureCredentialFingerprint } from "./fixture-dump.ts";
// control: evaluate the real ACP configuration producer independently of an
// external launch. The adapter admission assertion remains a separate test.
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import ts from "typescript";
import type { ProviderAdapter, SendTurnInput } from "../contracts.ts";
import { customMountEntries } from "../custom-mcp-mounts.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { connectedAppsServerName } from "../../shared/connected-app-names.ts";
import { MCP_LISTED_FILE_ENV } from "../mcp-listed.ts";

export function acpMountConfiguration(turn: SendTurnInput, memoryName = "murage-memory", listedFile?: (server: string) => string) {
  const source = ts.createSourceFile("core.ts", readFileSync(new URL("../drivers/acp/core.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let producer = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "acpMcpServers") producer = node.initializer!.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(producer).toContain("customMountEntries");
  const code = ts.transpileModule(`function configure(scope) { with(scope) { return (${producer})(turn, memoryName, listedFile); } }`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None, alwaysStrict: false } }).outputText;
  const configure = new Function(`${code}\nreturn configure;`)() as (scope: Record<string, unknown>) => Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }>;
  return configure({ turn, memoryName, listedFile, process, customMountEntries, computerProxyEnv, connectedAppsServerName, MCP_LISTED_FILE_ENV, SPAWNED_PROXIES, COMPUTER_PROXY_PATH: SPAWNED_PROXIES.computer });
}

/** Assert the real engine saw only relay shims, then inspect the independent
 * server-side configuration producer. Marker lifetime is covered by the
 * live MCP readiness suite; this callback pins only the configuration shape. */
export function fixtureAcpConfiguration(adapter: ProviderAdapter, wire: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }>) {
  const input = fixtureSubmittedInput(adapter);
  const memoryName = wire.find(server => /^murage-memory/.test(server.name))?.name ?? "murage-memory";
  const raw = acpMountConfiguration(input, memoryName, () => "/tmp/murage-mcp-listed-fixture/00000000-0000-4000-8000-000000000000." + "a".repeat(32));
  expect(wire.map(server => server.name)).toEqual(raw.map(server => server.name));
  for (const server of wire) {
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([SPAWNED_PROXIES.cliMountShim, "--server", server.name]);
    expect(server.env.map(entry => entry.name).sort()).toEqual(["ELECTRON_RUN_AS_NODE", "MURAGE_RELAY_SOCKET", "MURAGE_RELAY_TICKET"]);
    expect(server.env.find(entry => entry.name === "MURAGE_RELAY_TICKET")?.value).toBeTruthy();
  }
  return raw.map(server => ({ ...server, env: server.env.map(entry => ({ ...entry,
    value: /TOKEN|KEY|SECRET|PASSWORD/.test(entry.name) ? fixtureCredentialFingerprint(entry.value) : entry.value })) }));
}
