// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G0-MCP (1.0.19): a spawned MCP proxy loads server/proxy-turn-release.ts (and the mount fixtures load server/mcp-listed.ts)
// before it can answer `initialize`. When that module reached drivers/engine-input.ts (through ledger-refusal.ts, for one
// string constant), every proxy loaded the server's fence, lineage and release graph at start, listed its tools about a
// second late, and the ACP listed-wait refused the consuming turn at its cap before the listing arrived.
// The witness is the static value-import graph, so it does not depend on the speed of the host.
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { expect, it } from "vitest";
import ts from "typescript";
import { SPAWNED_PROXY_FILES } from "../shared/spawned-proxies.mjs";

const root = new URL("../", import.meta.url).pathname;
const parsed = new Map<string, string[]>();
const valueImports = (file: string): string[] => {
  const known = parsed.get(file);
  if (known) return known;
  const tree = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.importClause?.namedBindings;
      // `import { type A, type B }` loads nothing at runtime under type stripping only when every binding is a type
      const allTypes = !!named && ts.isNamedImports(named) && !node.importClause?.name && named.elements.length > 0 && named.elements.every(e => e.isTypeOnly);
      if (!allTypes) found.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const local = found.filter(path => path.startsWith(".") && /\.(?:ts|mjs)$/.test(path)).map(path => normalize(join(dirname(file), path)));
  parsed.set(file, local);
  return local;
};
/** Every local module `entry` loads at start, with the first import chain that reaches it. */
function reach(entry: string): Map<string, string[]> {
  const chains = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  for (const file of queue) {
    for (const next of valueImports(file)) {
      if (chains.has(next)) continue;
      chains.set(next, [...chains.get(file)!, next]);
      queue.push(next);
    }
  }
  return chains;
}
/** The server-side refusal and fence graph: a proxy process holds none of it. */
const SERVER_ONLY = ["server/drivers/engine-input.ts", "server/consuming-turn-response.ts", "server/memory/send-fence.ts", "server/memory/lineage-write.ts"];
const offenders = (entry: string): string[] => {
  const chains = reach(entry);
  return SERVER_ONLY.filter(file => chains.has(file)).map(file => chains.get(file)!.join(" -> "));
};

it("G0-MCP: the release module every spawned proxy loads does not load the server's refusal graph", () => {
  expect(offenders("server/proxy-turn-release.ts")).toEqual([]);
  expect(offenders("server/mcp-listed.ts")).toEqual([]);
  // the line a proxy answers a refused frame with is still the ledger's own line
  expect(reach("server/proxy-turn-release.ts").has("server/ledger-refusal-line.ts")).toBe(true);
});

it("G0-MCP: no spawned MCP proxy reaches drivers/engine-input.ts at start", () => {
  // consumingIngress is the server's own ingress child and owns the fence; the mount proxies do not.
  const proxies = Object.entries(SPAWNED_PROXY_FILES).filter(([name]) => name !== "consumingIngress").map(([, relative]) => `server/${relative}.ts`)
    .filter(entry => reach(entry).has("server/proxy-turn-release.ts"));
  expect(proxies.length).toBeGreaterThan(10);
  const reaching = proxies.filter(entry => reach(entry).has("server/drivers/engine-input.ts"));
  // The three computer entries load the ACP driver itself (through container-computer / vps-computer); that edge is theirs and older than
  // this row. Every other proxy stays clear, and none gets there through the release module.
  expect(reaching).toEqual(["server/computer-proxy.ts", "server/container-mcp.ts", "server/vps-container-mcp.ts"]);
  for (const entry of reaching) expect(reach(entry).get("server/drivers/engine-input.ts")!.join(" -> ")).toContain("server/drivers/acp/core.ts");
});

it("G0-MCP: the ledger line has one definition, shared by the server and the proxies", async () => {
  const leaf = await import("./ledger-refusal-line.ts");
  const ledger = await import("./ledger-refusal.ts");
  expect(ledger.LEDGER_REFUSAL_LINE).toBe(leaf.LEDGER_REFUSAL_LINE);
  expect(leaf.LEDGER_REFUSAL_LINE).toBe("I stopped this turn because some of its context is no longer available.");
  expect(valueImports("server/ledger-refusal-line.ts")).toEqual([]);
});
