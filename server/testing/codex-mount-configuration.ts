import { windowsHidePrelude } from "../../shared/win-hide-child-process.mjs";
// control: execute the driver's actual configuration statements without
// starting an external engine. Admission refusal is asserted separately by
// each caller; this is not a replacement adapter or a release implementation.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import ts from "typescript";
import type { SendTurnInput } from "../contracts.ts";
import { CODEX_TOOL_SURFACE, renderMurageTurn } from "../murage-tool-surface.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { customMountEntries } from "../custom-mcp-mounts.ts";
import { codexConfigMcpServerNames, mountedMcpServerNames } from "../drivers/codex-mcp-names.ts";
import { codexIsolationArgs } from "../drivers/codex-isolation.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { CRED_FILE_ENV, CRED_SERVER_ENV } from "../turn-credential.ts";
import { mountedTurn } from "../drivers/cli-mount-relay.ts";
import { splitTurnSecrets, type TurnSecrets } from "../drivers/turn-credentials.ts";

export function codexMountConfiguration(turn: SendTurnInput, environment: NodeJS.ProcessEnv = {}) {
  const text = readFileSync(new URL("../drivers/codex.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("codex.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(["CODEX_PHONE_MOUNT", "CODEX_MCP_TOOL_TIMEOUT_SEC", "CODEX_CUSTOM_MCP_STARTUP_TIMEOUT_SEC",
    "CODEX_MURAGE_MCP_STARTUP_TIMEOUT_SEC", "MCP_ENV_LAUNCHER_MARK", "MCP_ENV_LAUNCHER", "CODEX_TOOL_SURFACE_ARGS"]);
  const declarations: string[] = [];
  let mountFunction = "", collection = "", render = "", credentials = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text)) {
      declarations.push(`const ${node.name.text} = ${node.initializer!.getText(source)};`);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "mountMcpServer") mountFunction = node.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "{ stableServers, secrets }") credentials = node.getText(source);
    if (ts.isBlock(node)) {
      const statements = [...node.statements];
      const start = statements.findIndex(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === "mounts"));
      const end = statements.findIndex(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === "{ stableServers, secrets }"));
      if (start >= 0 && end > start) collection = statements.slice(start, end).map(statement => statement.getText(source)).join("\n");
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "renderMounts") render = `const ${node.getText(source)};`;
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(declarations).toHaveLength(names.size);
  expect(mountFunction).toContain("env_vars");
  expect(collection).toContain("customMountEntries");
  expect(render).toContain("CODEX_PHONE_MOUNT");
  expect(credentials).toContain("splitTurnSecrets");
  const code = ts.transpileModule(`function configure(scope) { with(scope) {
    ${declarations.join("\n")} ${mountFunction}
    const cloudHome = false, mounted = mountedTurn(turn), gatePlan = { mode: "legacy" };
    const appServerArgs = ["app-server", ...CODEX_TOOL_SURFACE_ARGS];
    ${collection}
    const ${credentials};
    ${render}
    renderMounts(stableServers);
    appServerArgs.push(...codexIsolationArgs(env, declaredInCodexConfig, new Set([...mounts.map(m => m.name), ...(turn.integrations?.phone ? [CODEX_PHONE_MOUNT] : [])])));
    return { argv: appServerArgs, env, turn, servers: Object.fromEntries(mounts.map(m => [m.name, m.server])), stableServers, secrets };
  } }`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None, alwaysStrict: false } }).outputText;
  const configure = new Function(`${code}\nreturn configure;`)() as (scope: Record<string, unknown>) => { argv: string[]; env: NodeJS.ProcessEnv; turn: SendTurnInput; servers: Record<string, unknown>; stableServers: Record<string, unknown>; secrets: TurnSecrets };
  return configure({ windowsHidePrelude, turn, env: { ...environment }, process, createHash, CODEX_TOOL_SURFACE, renderMurageTurn,
    computerProxyEnv, customMountEntries, codexConfigMcpServerNames, mountedMcpServerNames, codexIsolationArgs,
    SPAWNED_PROXIES, CRED_FILE_ENV, CRED_SERVER_ENV, splitTurnSecrets, mountedTurn,
    // Diagnostic destinations only; configuration decisions remain real.
    noteRefusedMcpServer: () => {}, noteRenamedMcpServer: () => {},
  });
}
