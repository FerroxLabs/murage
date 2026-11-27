// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as notifications from "./notify.ts";
const asker = { id: "lead", name: "Lead", threadId: "other-thread" };
const peer = { id: "peer", name: "Partner", threadId: "private-thread" };
it("announces the settled hand-off in the asking conversation after masking the full detail", () => {
  const build = (notifications as unknown as { buildDelegationNotification: Function }).buildDelegationNotification;
  expect(build).toBeTypeOf("function");
  const mask = (text: string) => text.replaceAll("fixture-private-value", "«redacted»");
  const detail = "x".repeat(130) + "fixture-private-value";
  const frame = build(asker, peer, "asking-thread", detail, "reply-1", mask);
  expect(frame).toMatchObject({ kind: "done", botId: "lead", botName: "Partner", threadId: "asking-thread", messageId: "reply-1", deliveryId: "delegation:reply-1" });
  expect(frame.body).not.toContain("fixture-");
  expect(build({ ...asker, notifications: false }, peer, "asking-thread", "Done", "reply-1", mask)).toBeNull();
  expect(build(asker, { ...peer, notifications: false }, "asking-thread", "Done", "reply-1", mask)).toBeNull();
});

it("the durable return port announces one delivered reply and schedules one parent resume", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("  returned: (taskId, threadId, result) => {", source.indexOf("const askerWakePort:"));
  const end = source.indexOf("\n};", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const code = ts.transpileModule(`const port = {${source.slice(start, end)}};`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText;
  const tasks = new Set<string>(), notify = vi.fn(), wakeAsker = vi.fn();
  const deps = {
    askerWakes: { deliver: (id: string) => { if (tasks.has(id)) return false; tasks.add(id); return true; }, durable: () => true },
    queueMicrotask: (fn: () => void) => fn(), wakeAsker, notify,
    isWorkspaceOwner: () => true, threadHumanPrincipal: () => ({}),
    store: { botByThread: () => asker, bot: () => peer, messageById: () => ({ text: "Reply saved" }) },
    buildDelegationNotification: notifications.buildDelegationNotification,
    sanitizeDisplayTextUnit: (text: string[]) => text,
  };
  const returned = new Function(...Object.keys(deps), code + "return port.returned;")(...Object.values(deps));
  for (let n = 0; n < 2; n++) expect(returned("task-1", "asking-thread", { toBotId: "peer", messageId: "reply-1", ok: true })).toBe(true);
  expect(notify).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ threadId: "asking-thread", body: "Reply saved" }));
  expect(wakeAsker).toHaveBeenCalledOnce();
  notify.mockImplementationOnce(() => { throw new Error("fixture notification unavailable"); });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(returned("task-2", "asking-thread", { toBotId: "peer", messageId: "reply-2", ok: false })).toBe(true);
  } finally { logged.mockRestore(); }
});

it("a direct delegation announces its delivered reply once, while room and ordinary finishes keep their notices", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf('        if (routineRun?.status !== "failed"');
  const end = source.indexOf('        if (screenPollers.get(bot.id)', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText;
  for (const [delegated, directSource, expected] of [[true, true, 0], [true, false, 1], [false, false, 1]] as const) {
    const notify = vi.fn();
    const deps = {
      routineRun: undefined, replacementOwnsThread: false, commandRefusal: false, event: { threadId: "worker-thread" }, turnStopped: () => false,
      reply: "Reply saved", routineReportThread: undefined, turnStartedAtMs: new Map(), notify,
      buildNotification: () => ({ kind: "done" }), bot: peer, randomUUID: () => "delivery-1", engineLabelOf: () => "Fixture", filesTouchedSince: () => 0, askDevice: undefined,
      delegationWatch: new Map(delegated ? [["worker-thread", { sourceThreadId: "source-thread" }]] : []),
      store: { botByThread: () => directSource ? asker : undefined },
    };
    new Function(...Object.keys(deps), code)(...Object.values(deps));
    expect(notify.mock.calls.length).toBe(expected);
  }
});
