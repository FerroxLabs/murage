import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { OpenCodeQuiet } from "./opencode-quiet.ts";

// OPENCODE-QUIET-1023 W5 (new pin, hook level): an in-turn respawn (replaceForBudget) detaches the old
// process's hooks before closing it, so the old child's stderr never reaches the turn's quiet observer,
// while the new process's stderr does. Runs the real core.ts replaceForBudget and the real child stderr handler.
const source = readFileSync(new URL("./core.ts", import.meta.url), "utf8");
const slice = (from: string, to: string) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  if (start < 0 || end < 0 || source.indexOf(from, start + 1) >= 0) throw new Error(`core.ts slice ${from}`);
  return source.slice(start, end);
};
const record = (session: string) => `timestamp=2026-11-06T14:22:31.873Z level=ERROR run=fixture message="stream error" providerID=fixture modelID=mock session.id=${session} small=false agent=build mode=primary error.error="AI_APICallError: Local fixture rate limit"\n`;

it("W5 the respawned turn's old child stderr reaches no hook; the new child's reaches quiet.feed", async () => {
  const replace = slice("const replaceForBudget = async", "restartNativePosture = async");
  const handler = slice('child.stderr.on("data", (chunk: Buffer) => {', "// Exit or error: this exact process leaves the driver pool");
  const quiet = new OpenCodeQuiet(vi.fn());
  quiet.start("ses_fixture");
  const feed = vi.spyOn(quiet, "feed");
  const hook = (text: string) => quiet.feed(text);
  const listeners: Array<(chunk: Buffer) => void> = [];
  const makeProc = () => {
    const proc = { owner: { hooks: { stderr: vi.fn(hook) } as { stderr: (text: string) => void } | null }, child: { stderr: { on: (_: string, fn: (chunk: Buffer) => void) => listeners.push(fn) } } };
    return proc;
  };
  const oldProc = makeProc(), newProc = makeProc();
  const oldHooks = oldProc.owner.hooks!;
  const context: Record<string, unknown> = {
    proc: oldProc, teardown: { markStopRequested: () => {}, wait: async () => ({ closeConfirmed: true }) }, mountRelay: undefined,
    sessionId: "ses_fixture", reloadCursor: undefined, state: { promptSent: true }, turn: {}, threadId: "respawn-thread",
    externalHalt: () => false, settleHalted: () => {}, stopBudget: () => 0, ProviderStopUnconfirmedError: Error,
    rotateCatalogGeneration: () => {}, applyBudget: () => {}, armTrustHold: () => {}, freshMcpMountAdmission: () => ({}),
    SOURCE: "opencode.acp", noticeCount: 0, notices: [],
    // The old child is still alive while it is closed: it writes one owned record through the real handler.
    closeProcess: (_thread: string, proc: typeof oldProc) => { listeners[0]!(Buffer.from(record("ses_fixture"))); expect(proc).toBe(oldProc); },
    spawnFresh: () => { context.proc = newProc; },
  };
  // Each process's real stderr listener reads `proc` from its own spawn scope.
  const attach = runInNewContext(`(function(proc, child){ ${stripTypeScriptTypes(handler)} })`, context) as (proc: unknown, child: unknown) => void;
  attach(oldProc, oldProc.child); attach(newProc, newProc.child);
  expect(listeners).toHaveLength(2);
  runInNewContext(`${stripTypeScriptTypes(replace)}; globalThis.run = replaceForBudget;`, context);
  expect(await (context.run as (decision: unknown) => Promise<boolean>)({ kind: "ok" })).toBe(true);
  expect(oldHooks.stderr).toHaveBeenCalledTimes(0);
  expect(context.proc).toBe(newProc);
  expect(oldProc.owner.hooks).toBeNull();
  expect(feed).toHaveBeenCalledTimes(0);
  listeners[1]!(Buffer.from(record("ses_fixture")));
  expect(newProc.owner.hooks!.stderr).toHaveBeenCalledTimes(1);
  expect(feed).toHaveBeenCalledTimes(1);
  quiet.stop();
});
