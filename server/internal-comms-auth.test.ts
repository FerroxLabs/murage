import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Exercise the production dispatch prefix with every later dispatch/fence
// dependency blocked. The comms e2e suites also check the real HTTP response.
const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.filter(ts.isVariableStatement)
  .flatMap(statement => [...statement.declarationList.declarations])
  .find(declaration => declaration.name.getText(source) === "handleRequest");
if (!declaration?.initializer || !ts.isArrowFunction(declaration.initializer) || !ts.isBlock(declaration.initializer.body)) throw new Error("production request handler missing");
const original = declaration.initializer;
const statements = [...(original.body as ts.Block).statements];
const gate = statements.findIndex(statement => ts.isExpressionStatement(statement)
  && ts.isAwaitExpression(statement.expression) && ts.isCallExpression(statement.expression.expression)
  && statement.expression.expression.expression.getText(source) === "gateWriteRequest");
if (gate < 0) throw new Error("production dispatch gate missing");
const prefix = ts.factory.updateArrowFunction(original, original.modifiers, original.typeParameters, original.parameters,
  original.type, original.equalsGreaterThanToken, ts.factory.updateBlock(original.body as ts.Block, statements.slice(0, gate + 1)));
const printed = ts.createPrinter().printNode(ts.EmitHint.Expression, prefix, source);
const handler = ts.transpileModule(`const handleRequest = ${printed}; handleRequest;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function dispatch(claim: object | null = null) {
  const laterDispatch = new Error("later dispatch reached");
  const blocked = vi.fn(() => { throw laterDispatch; });
  const json = vi.fn((_res: unknown, status: number, body: unknown) => ({ status, body }));
  const resolve = vi.fn(() => claim);
  const noteOwnerRequest = vi.fn();
  const handle = runInNewContext(handler, {
    URL, PORT: 1, ownerClock: { note: vi.fn() },
    ioBudget: { noteOwnerRequest },
    TURN_RELEASE_VERDICT_PATH: "/api/internal/turn-release/v1/verdict",
    internalCapabilities: { resolve, retiredOwner: blocked },
    chiefProposals: { bindingFor: blocked }, internalResponseBindings: { get: blocked },
    gateWriteRequest: blocked, denyConsumingHttp: blocked, consumingHttpWriter: blocked,
    json,
  });
  return { handle, json, resolve, blocked, laterDispatch, noteOwnerRequest };
}

it.each([
  ["GET", "/api/internal/agents?self=fixture"],
  ["POST", "/api/internal/ask-bot"],
])("%s %s rejects unauthenticated requests before dispatch or fence state", async (method, url) => {
  for (const authorization of [undefined, "Bearer unknown", `Bearer ${"0".repeat(48)}`]) {
    const f = dispatch();
    const headers = { authorization, "x-murage-release-token": "untrusted" };
    await expect(f.handle({ method, url, headers }, {})).resolves.toEqual({ status: 401, body: { error: "internal authentication required" } });
    expect(f.noteOwnerRequest).toHaveBeenCalledExactlyOnceWith(method, url);
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(authorization);
    expect(f.json).toHaveBeenCalledOnce();
    expect(f.blocked).not.toHaveBeenCalled();
  }
});

it("authenticated comms still enter the consuming binding gate", async () => {
  const f = dispatch({ threadId: "fixture-thread", generation: "fixture-generation" });
  await expect(f.handle({ method: "GET", url: "/api/internal/agents", headers: {} }, {})).rejects.toBe(f.laterDispatch);
  expect(f.noteOwnerRequest).toHaveBeenCalledExactlyOnceWith("GET", "/api/internal/agents");
  expect(f.blocked).toHaveBeenCalledExactlyOnceWith("fixture-thread", "fixture-generation");
  expect(f.json).not.toHaveBeenCalled();
});

it.each([
  ["POST", "/api/internal/agents"],
  ["GET", "/api/internal/ask-bot"],
  ["GET", "/api/internal/agents-extra"],
  ["POST", "/api/internal/turn-release/v1/verdict"],
])("%s %s keeps its existing dispatch contract", async (method, url) => {
  const f = dispatch();
  await expect(f.handle({ method, url, headers: {} }, {})).rejects.toBe(f.laterDispatch);
  expect(f.noteOwnerRequest).toHaveBeenCalledExactlyOnceWith(method, url);
  expect(f.blocked).toHaveBeenCalledOnce();
  expect(f.json).not.toHaveBeenCalled();
});
