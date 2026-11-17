// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { botEngineSignedIn, botEngineSignIn, botSignedInEngines, polledBotEngineSignIn, polledBotSignedInEngines, readCloudHomeSignIns, readSignInState, configureCloudSignIns, forgetCloudSignIns } from "./signin-status.ts";

const child = (code: number, stdout: string, stderr = "") => {
  const c = new EventEmitter() as ChildProcess;
  Object.assign(c, { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  queueMicrotask(() => { c.stdout!.emit("data", stdout); c.stderr!.emit("data", stderr); c.emit("close", code); });
  return c;
};
afterEach(() => { configureCloudSignIns(); forgetCloudSignIns(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("logs a failed launcher once per cause per minute across all seven unknown fallbacks", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  let now = 100_000, code = "ECONNREFUSED";
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const failure = () => Object.assign(new Error("private launcher canary"), { code });
  configureCloudSignIns({ bots: () => ["bot-a"], launch: () => { throw failure(); } });
  const unknownReads = async () => {
    expect(await botEngineSignedIn("codex", "bot-a")).toBeUndefined();
    expect(await botEngineSignIn("codex", "bot-a")).toBeUndefined();
    expect(await botSignedInEngines("bot-a")).toBeUndefined();
    expect(await polledBotEngineSignIn("codex", "bot-a")).toBeUndefined();
    expect(await polledBotSignedInEngines("bot-a")).toBeUndefined();
    expect(await readCloudHomeSignIns()).toBeNull();
    expect(await readSignInState(async () => { throw failure(); })).toBe("unknown");
  };
  for (let i = 0; i < 10; i++) await unknownReads();
  expect(warn).toHaveBeenCalledExactlyOnceWith("[cloud-signin] launcher read failed cause=ECONNREFUSED engine=codex bot=bot-a");
  code = "EACCES";
  await unknownReads();
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenLastCalledWith("[cloud-signin] launcher read failed cause=EACCES engine=codex bot=bot-a");
  now += 60_000;
  await unknownReads();
  expect(warn).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("canary");
  // A successful read is silent, and still reports the sign-in.
  configureCloudSignIns({ launch: () => child(0, JSON.stringify({ engines: { codex: { signedIn: true } } })) });
  expect(await botEngineSignedIn("codex", "bot-a")).toBe(true);
  expect(warn).toHaveBeenCalledTimes(3);
});

it("distinguishes launcher exits from unreadable output without logging stderr or malformed input", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  configureCloudSignIns({ launch: () => child(1, "", "private stderr canary") });
  expect(await botEngineSignedIn("kimiAgent", "bot-b")).toBeUndefined();
  expect(warn).toHaveBeenLastCalledWith("[cloud-signin] launcher read failed cause=launcher-exit engine=kimiAgent bot=bot-b");
  configureCloudSignIns({ launch: () => child(0, "private malformed canary") });
  expect(await botEngineSignedIn("kimiAgent", "bot-b")).toBeUndefined();
  expect(warn).toHaveBeenLastCalledWith("[cloud-signin] launcher read failed cause=launcher-unreadable engine=kimiAgent bot=bot-b");
  configureCloudSignIns({ launch: () => { throw Object.assign(new Error("private error canary"), { code: "PRIVATE_CANARY" }); } });
  expect(await botEngineSignedIn("private/input", "../private")).toBeUndefined();
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/canary|PRIVATE|private|\.\.\//);
  const count = warn.mock.calls.length;
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  expect(await botEngineSignIn("codex", "bot-b")).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(count);
});
