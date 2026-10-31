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
      ["stamp", `echo ${sentinel}`, { call: { ...context("echo fixture").call, toolIdentity: { namespace: "mcp ", name: "browser__open" } } }],
      ["identity", `echo ${sentinel}`, { call: { ...context("echo fixture").call, toolIdentity: { namespace: "elsewhere", name: "browser__open" } } }],
    ];
    for (const [id, command, patch] of rows) expect(autoVerdict({ ...full, id }, "shell", sentinel, context(command, patch)).approve).toBeNull();
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "approvals: asked bot=wipe tool=shell reason=always-ask:delete-root origin=owner unattended=0 cmd=shell level=full suppressed=0",
      "approvals: asked bot=unreadable tool=shell reason=unreadable origin=other unattended=0 cmd=shell reader=held level=full held=unread suppressed=0",
      "approvals: asked bot=env tool=shell reason=unread-call:U20 origin=owner unattended=0 cmd=shell level=full held=unread suppressed=0",
      "approvals: asked bot=pin tool=shell reason=unread-call:U19 origin=owner unattended=0 cmd=shell level=full held=unread suppressed=0",
      "approvals: asked bot=stop tool=shell reason=stop-line:pay origin=owner unattended=0 cmd=shell level=full suppressed=0",
      "approvals: asked bot=cut tool=shell reason=unread-call:truncated origin=owner unattended=0 cmd=shell level=full held=unread suppressed=0",
      "approvals: asked bot=stamp tool=shell reason=unread-call:stamp-spelling origin=owner unattended=0 cmd=shell level=full held=unread suppressed=0",
      "approvals: asked bot=identity tool=shell reason=unread-call:identity origin=owner unattended=0 cmd=shell level=full held=unread suppressed=0",
    ]);
    autoVerdict({ id: "no-grant" }, "shell", sentinel, context(`echo ${sentinel}`));
    expect(log.mock.calls.at(-1)?.[0]).toContain("reason=no-grant");
    const before = log.mock.calls.length;
    expect(autoVerdict(full, "shell", sentinel, context(`echo ${sentinel}`)).approve).not.toBeNull();
    expect(log).toHaveBeenCalledTimes(before);
    const text = JSON.stringify(log.mock.calls);
    for (const forbidden of [sentinel, "/private/path", "rm -rf", "PAGER=", "echo "]) expect(text).not.toContain(forbidden);
  });
  // Sean's No-limits report (APPROVALS-LOG-LEVEL): the line alone says the bot's level and what held the call.
  it("names the bot's level and the class of what held the call, by fixed name, and no command, path or matched text", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const sentinel = "TOP_SECRET_ARGUMENT", path = `/private/path/${sentinel}`;
    const noLimits = { ...full, noLimits: true };
    const levels: Array<[string, object, string]> = [
      ["ask", { autoApprove: false }, "level=ask"], ["auto", { autoApprove: true }, "level=auto"],
      ["full", full, "level=full"], ["none", noLimits, "level=no-limits"],
    ];
    for (const [id, bot, level] of levels) {
      autoVerdict({ ...bot, id: `level-${id}` }, "shell", sentinel, context(`cat ${path}/.ssh/id_rsa`));
      expect(log.mock.calls.at(-1)?.[0]).toContain(` ${level} `);
    }
    const holds: Array<[string, string, Partial<AutoContext>]> = [
      ["key-row", `cat ~/.ssh/id_rsa # ${sentinel}`, {}],
      ["home-glob", `cat ~/.x/*${sentinel}`, {}],
      ["local-hold", `echo ${sentinel}`, { localHold: path }],
      ["real-path", `echo ${sentinel}`, { realPathCannot: path }],
      ["unread", `echo ${sentinel}`, { envUnread: path }],
    ];
    for (const [held, command, patch] of holds) {
      expect(autoVerdict({ ...noLimits, id: `held-${held}` }, "shell", command, context(command, patch)).approve).toBeNull();
      const line = String(log.mock.calls.at(-1)?.[0]);
      expect(line).toContain(`bot=held-${held} `);
      expect(line).toContain(` level=no-limits held=${held} suppressed=0`);
    }
    // the card's words are the same as before the classes had names
    const rule = (patch: Partial<AutoContext>) => autoVerdict(noLimits, "shell", "ls", context("ls", patch)).rule;
    expect(rule({ localHold: "x" })).toBe("the engine's own check held this as a key file (x)");
    expect(rule({ realPathCannot: "x" })).toBe("a path this call names could not be followed to where it lands, so it is held as a key file (x)");
    expect(autoVerdict(noLimits, "shell", "cat ~/.x/*", context("cat ~/.x/*")).rule).toBe("a glob in a path under the home folder could name a key file");
    autoVerdict(noLimits, "shell", sentinel, context(`echo ${sentinel}`, { fullAccessOrigin: "other", stopLine: { kind: "pay", what: sentinel } }));
    expect(log.mock.calls.at(-1)?.[0]).not.toContain(" held=");
    const text = JSON.stringify(log.mock.calls);
    for (const forbidden of [sentinel, "/private/path", ".ssh", "id_rsa", "~/", "echo "]) expect(text).not.toContain(forbidden);
  });
  it("gives each held class its own line inside the minute", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const bot = { ...full, id: "class-window" };
    const ask = (patch: Partial<AutoContext>) => autoVerdict(bot, "shell", "echo private", context("echo private", patch));
    ask({ localHold: "private" }); ask({ localHold: "private" }); ask({ realPathCannot: "private" });
    expect(log).toHaveBeenCalledTimes(2);
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
    expect(log.mock.calls.at(-1)?.[0]).toBe("approvals: asked bot=rate-fixture tool=shell reason=unread-call:U20 origin=owner unattended=0 cmd=shell level=full held=unread suppressed=3");
    ask(); vi.setSystemTime(1_120_000); ask();
    expect(log.mock.calls.at(-1)?.[0]).toContain("suppressed=1");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });
  it("does not let malformed tool labels inject command text or log lines", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    autoVerdict({ id: "bad\nid" }, "echo /secret/path\nforged", "TOP_SECRET", { question: true });
    expect(log.mock.calls).toEqual([["approvals: asked bot=unknown tool=unknown reason=question-tool origin=owner unattended=0 cmd=none level=ask suppressed=0"]]);
  });
});
