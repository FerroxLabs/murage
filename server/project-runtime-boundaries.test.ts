// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { projectThreads } from "./project-memory-tools.ts";
import { ProjectLateWrites } from "./project-run-events.ts";
import { accountPresentedProjectEvent } from "./project-usage-dispatch.ts";
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
function nodes(test: (node: ts.Node) => boolean) {
  const found: ts.Node[] = [];
  function visit(node: ts.Node) { if (test(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(ast); return found;
}
function evaluate(code: string, deps: Record<string, unknown>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), js)(...Object.values(deps));
}
it("brief route resolves project task threads and retained former-member desks", () => {
  const declaration = nodes(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === "projectThreadIds")[0];
  expect(declaration).toBeDefined();
  const group = { id: "grp", threadId: "main", memberIds: ["current"], tasks: [{ threadId: "project-task" }] };
  const store = { groups: [group], bots: [{ id: "former", tasks: [{ threadId: "retained-desk", channelProjectDesk: { groupId: "grp" } }, { threadId: "foreign", channelProjectDesk: { groupId: "other" } }] }] };
  const threads = evaluate(`const ${declaration.getText(ast)}; return projectThreadIds;`, { group, store, projectThreads, projectMainThread: () => "main" });
  expect(new Set(threads)).toEqual(new Set(["main", "project-task", "retained-desk"]));
});
// 0.1.61: no turn has a duration deadline; only the silence watchdog holds
// for a presented card (a card run otherwise ends on Stop or its budget).
it("the watchdog waits only after folder-held approval presentation, including retries", () => {
  type Event = { type: string; threadId: string; turnId: string; requestId: string };
  const raw: Array<(e: Event) => void> = [], presented: Array<(e: Event) => void> = [];
  const bus = { subscribe: (fn: (e: Event) => void) => { raw.push(fn); return () => {}; } };
  const presentedRequests = { subscribe: (fn: (e: Event) => void) => { presented.push(fn); return () => {}; }, publish: (e: Event) => presented.forEach(fn => fn(e)) };
  const watchdog = { setWaitingOnHuman: vi.fn(), touch: vi.fn() };
  const calls = nodes(n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "subscribe"
    && (n.arguments[0]?.getText(ast).includes("watchdog.setWaitingOnHuman") || n.arguments[0]?.getText(ast).includes("deadline.setWaitingOnHuman")));
  expect(calls).toHaveLength(1);
  const deps = { bus, presentedRequests, watchdog, shouldIgnoreProviderEvent: () => false, memoryDispatches: new Map(), lateProjectWrites: { complete: vi.fn() }, threadId: "room", providerTurnId: "turn" };
  calls.forEach(call => evaluate(call.getText(ast), deps));
  const begin = source.indexOf("const foldRuntimeEvent = (event: RuntimeEvent) => {");
  const end = source.indexOf("  const localVmTarget", begin);
  let held = true;
  const account = vi.fn();
  const fold = evaluate(`${source.slice(begin, end)} }; return foldRuntimeEvent;`, { ...deps, replyGuardContext: () => null, accountProjectEvent: account,
    accountPresentedProjectEvent, holdProjectWriteApproval: () => held });
  const approval = { type: "request.opened", threadId: "room", turnId: "turn", requestId: "approval" };
  raw.forEach(fn => fn(approval)); fold(approval);
  expect(watchdog.setWaitingOnHuman).not.toHaveBeenCalled();
  expect(account).not.toHaveBeenCalled();
  held = false; fold(approval);
  expect(watchdog.setWaitingOnHuman).toHaveBeenCalledExactlyOnceWith("room", true, "approval");
  const resolved = { ...approval, type: "request.resolved" };
  raw.forEach(fn => fn(resolved)); fold(resolved);
  expect(watchdog.setWaitingOnHuman).toHaveBeenLastCalledWith("room", false, "approval");
});

it("retired provider output still releases only its matching late-write resources", () => {
  vi.useFakeTimers();
  try {
    const lateProjectWrites = new ProjectLateWrites(), release = vi.fn(), newerRelease = vi.fn(), retry = vi.fn();
    const identity = { threadId: "room", generation: "retired-generation", turnId: "retired-turn" };
    lateProjectWrites.add(identity, release); lateProjectWrites.retry(identity, "ask", retry);
    lateProjectWrites.add({ ...identity, generation: "new-generation", turnId: "new-turn" }, newerRelease);
    const callback = nodes(n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.getText(ast) === "bus.subscribe"
      && !!n.arguments[0]?.getText(ast).includes("lateProjectWrites.complete"))[0] as ts.CallExpression;
    expect(callback).toBeDefined();
    const event = { type: "turn.completed", threadId: "room", turnId: "retired-turn" };
    const endHeldWriteWaits = vi.fn();
    evaluate(`const receive = ${callback.arguments[0].getText(ast)}; receive(event); receive(event);`, {
      event, lateProjectWrites, endHeldWriteWaits, memoryDispatches: new Map(), shouldIgnoreProviderEvent: () => true,
      pendingRoomStops: new Map(), projectTurnLeases: { complete: vi.fn() }, internalCapabilities: { completeProviderTurn: vi.fn() }, internalTurnOwners: new Map(),
    });
    vi.advanceTimersByTime(250);
    expect(release).toHaveBeenCalledTimes(1);
    expect(newerRelease).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    // a held write approval's watchdog wait ends with its turn
    expect(endHeldWriteWaits).toHaveBeenCalledWith("room");
  } finally { vi.useRealTimers(); }
});
