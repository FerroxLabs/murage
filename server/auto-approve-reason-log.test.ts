// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";

const full = { id: "reason-fixture", autoApprove: true, fullAccess: true };
function context(command: string, patch: Partial<AutoContext> = {}): AutoContext {
  return { fullAccessOrigin: "owner", commandText: command, commandCwd: "/private/path",
    call: { engine: "acp", toolKind: "execute", toolCall: { name: "shell", input: { command } } }, ...patch };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// 1.0.10 (NOLIMITS-CARDS r5): each line also names who started the turn, whether it was unattended, the command
// class and, for an unreadable hold, the reader's class. All value-free.
describe("approval ask reason logging", () => {
  it("logs early holds with fixed tags and never command text, values, arguments or paths", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const sentinel = "TOP_SECRET_ARGUMENT";
    const rows: Array<[string, string, Partial<AutoContext>]> = [
      ["wipe", `rm -rf /; echo ${sentinel}`, {}],
      ["unreadable", `echo ${sentinel} 'unterminated`, { fullAccessOrigin: "other" }],
      ["env", `echo ${sentinel}`, { envUnread: `/private/path/${sentinel}` }],
      ["pin", `PAGER=${sentinel} git log`, { handedPins: new Map([["PAGER", "cat"]]) }],
      ["stop", `echo ${sentinel}`, { stopLine: { kind: "pay", what: sentinel, place: `/private/path/${sentinel}` } }],
      ["cut", `echo ${sentinel}`, { call: { ...context("echo fixture").call, truncated: true } }],
    ];
    for (const [id, command, patch] of rows) expect(autoVerdict({ ...full, id }, "shell", sentinel, context(command, patch)).approve).toBeNull();
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "approvals: asked bot=wipe tool=shell reason=always-ask:delete-root origin=owner unattended=0 cmd=shell suppressed=0",
      "approvals: asked bot=unreadable tool=shell reason=unreadable origin=other unattended=0 cmd=shell reader=quote suppressed=0",
      "approvals: asked bot=env tool=shell reason=unread-call:U20 origin=owner unattended=0 cmd=shell suppressed=0",
      "approvals: asked bot=pin tool=shell reason=unread-call:U19 origin=owner unattended=0 cmd=shell suppressed=0",
      "approvals: asked bot=stop tool=shell reason=stop-line:pay origin=owner unattended=0 cmd=shell suppressed=0",
      "approvals: asked bot=cut tool=shell reason=unread-call:truncated origin=owner unattended=0 cmd=shell suppressed=0",
    ]);
    autoVerdict({ id: "no-grant" }, "shell", sentinel, context(`echo ${sentinel}`));
    expect(log.mock.calls.at(-1)?.[0]).toContain("reason=no-grant");
    const before = log.mock.calls.length;
    expect(autoVerdict(full, "shell", sentinel, context(`echo ${sentinel}`)).approve).not.toBeNull();
    expect(log).toHaveBeenCalledTimes(before);
    const text = JSON.stringify(log.mock.calls);
    for (const forbidden of [sentinel, "/private/path", "rm -rf", "PAGER=", "echo "]) expect(text).not.toContain(forbidden);
  });
  it("limits each bot/tool/class to one line per minute and reports suppressed counts", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000_000);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const bot = { ...full, id: "rate-fixture" }, command = "echo private";
    const ask = (id = bot.id, tool = "shell", reason = "env") => autoVerdict({ ...bot, id }, tool, command, context(command,
      reason === "env" ? { envUnread: "private" } : { stopLine: { kind: "pay", what: "private" } }));
    ask(); ask(); ask();
    expect(log).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_059_999); ask(); expect(log).toHaveBeenCalledTimes(1);
    ask("rate-other"); ask(bot.id, "Bash"); ask(bot.id, "shell", "stop");
    expect(log).toHaveBeenCalledTimes(4);
    vi.setSystemTime(1_060_000); ask();
    expect(log).toHaveBeenCalledTimes(5);
    expect(log.mock.calls.at(-1)?.[0]).toBe("approvals: asked bot=rate-fixture tool=shell reason=unread-call:U20 origin=owner unattended=0 cmd=shell suppressed=3");
    ask(); vi.setSystemTime(1_120_000); ask();
    expect(log.mock.calls.at(-1)?.[0]).toContain("suppressed=1");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });
  it("does not let malformed tool labels inject command text or log lines", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    autoVerdict({ id: "bad\nid" }, "echo /secret/path\nforged", "TOP_SECRET", { question: true });
    expect(log.mock.calls).toEqual([["approvals: asked bot=unknown tool=unknown reason=question-tool origin=owner unattended=0 cmd=none suppressed=0"]]);
  });
});
