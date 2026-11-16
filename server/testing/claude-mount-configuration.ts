// control: real configuration producers without external adapter admission.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "vitest";
import ts from "typescript";
import { extractFunction } from "./source-extract.ts";
import type { SendTurnInput } from "../contracts.ts";
import { claudeShellServers } from "../drivers/claude.ts";
import { bindCredentialPath, createTurnCredentialStore, splitTurnSecrets, type TurnCredentialStore } from "../drivers/turn-credentials.ts";

function mountUnit() {
  const source = ts.createSourceFile("claude.ts", readFileSync(new URL("../drivers/claude.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let collection = "", disallowed = "", native = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "nativeTools") native = node.initializer!.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "disallowedTools") disallowed = node.initializer!.getText(source);
    if (ts.isBlock(node)) {
      const statements = [...node.statements];
      const start = statements.findIndex(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === "mcpServers"));
      if (start >= 0) {
        const end = statements.findIndex((statement, index) => index > start && ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === "mcpConfigPath"));
        if (end > start) collection = statements.slice(start, end).map(statement => statement.getText(source)).join("\n");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(collection).toContain("customMountEntries");
  expect(collection).toContain("permissionSocketPath");
  expect(disallowed).toContain("ListAgents");
  const constant = (name:string) => {
    for(const statement of source.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)
      if(ts.isIdentifier(declaration.name)&&declaration.name.text===name&&declaration.initializer)return declaration.initializer.getText(source);
    throw new Error(`FIXTURE_SELECTION_MISSING ${name}`);
  };
  const unit = extractFunction({ file: new URL("../drivers/claude.ts", import.meta.url),
    select: () => `() => {
      const args = []; const config = {};
      const NODE_ENV_FLAG = ${constant("NODE_ENV_FLAG")};
      const CLAUDE_BROKER_TOOLS = ${constant("CLAUDE_BROKER_TOOLS")};
      const nativeTools = ${native};
      const disallowedTools = ${disallowed};
      if(disallowedTools.length) args.push("--disallowedTools", disallowedTools.join(","));
      ${collection}
      args.push("--allowedTools", allowed.filter(tool => !new Set(["Grep", "Glob"]).has(tool)).join(","));
      return { argv: args, mcpServers, turnPrompt, turn };
    }` });
  return unit;
}
const unit=mountUnit();
await unit.preload();
export function claudeMountConfiguration(turn: SendTurnInput, retainedCredential?: TurnCredentialStore) {
  const configure = (scope: Record<string, unknown>) => unit.preflightSync(scope).value() as { argv: string[]; mcpServers: Record<string, unknown>; turnPrompt: string; turn: SendTurnInput };
  const configuration = configure({turn,threadId:turn.threadId});
  const { stableServers, secrets } = splitTurnSecrets(configuration.mcpServers);
  const credential = retainedCredential ?? (Object.keys(secrets).length ? createTurnCredentialStore() : undefined);
  const dir = mkdtempSync(join(tmpdir(), "murage-mcp-configuration-")), path = join(dir, "mcp.json");
  try {
    credential?.write(secrets);
    const bound = credential ? bindCredentialPath(stableServers, credential.path) : stableServers;
    const mcpConfig = { mcpServers: claudeShellServers({ kind: "murage-exec", shell: process.platform === "win32" ? "C:\\fixture\\bin\\bash.exe" : "/bin/sh" }, bound) };
    writeFileSync(path, JSON.stringify(mcpConfig), { mode: 0o600 });
    const result = { argv: [...configuration.argv, "--mcp-config", path], mcpConfig, turn: configuration.turn, stableServers, secrets,
      credFile: credential ? { path: credential.path, content: JSON.parse(readFileSync(credential.path, "utf8")) } : null };
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(mcpConfig);
    return result;
  } finally { if (!retainedCredential) credential?.dispose(); rmSync(dir, { recursive: true, force: true }); }
}
