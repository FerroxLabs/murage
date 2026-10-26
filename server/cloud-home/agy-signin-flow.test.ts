// SPDX-License-Identifier: AGPL-3.0-or-later
// Antigravity's in-chat sign-in, start to finish against the REAL message store on an isolated data folder: the start
// shows Google's checked link and holds the pty, the code goes through its own route (or is swallowed by the /messages
// guard) and is then found NOWHERE in the data folder or in anything printed. Fake pty; no network, no sign-in.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { murageLine } from "../murage-line.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { AgySigninHolds } from "./agy-signin-code.ts";
import { acceptSigninCode, swallowPastedCode } from "./agy-signin-routes.ts";
import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_REDIRECT, AgySigninStarter, agySigninRequired, checkedGoogleLink, configureAgySignin, osc8Link } from "./agy-signin-start.ts";

const CODE = "4/0AfFixtureNeverStoredCode_9Xk2-LmQ7";
const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const LINK = `https://accounts.google.com/o/oauth2/auth?client_id=${AGY_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(AGY_OAUTH_REDIRECT)}&response_type=code&state=s1&code_challenge=abc&code_challenge_method=S256`;
const osc = (url: string) => `\x1b[2J Sign in:\r\n\x1b]8;;${url}\x1b\\Open this link\x1b]8;;\x1b\\\r\n`;

/** A pty stand-in: prints `output` once, records every byte written to it, exits when told. */
function fakePty(output: string) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; pid?: number; kill: () => boolean };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const written: Buffer[] = [];
  child.stdin.on("data", (d: Buffer) => written.push(Buffer.from(d)));
  child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
  queueMicrotask(() => child.stdout.write(output));
  return { child: child as unknown as ChildProcess, written: () => Buffer.concat(written).toString("utf8"), exit: (code: number) => child.emit("close", code) };
}
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const p = join(dir, name); try { return statSync(p).isDirectory() ? filesUnder(p) : [p]; } catch { return []; } });

let store: Store;
let printed = "";
beforeEach(() => {
  removeTempDirSync(DATA_DIR);
  store = new Store(selection);
  printed = "";
  for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => { printed += String(chunk); return true; }) as never);
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { printed += args.map(String).join(" "); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("the link is Google's, exactly", () => {
  it("accepts agy's own sign-in link and refuses every other host, path, client or redirect", () => {
    expect(checkedGoogleLink(LINK)).toBe(LINK);
    for (const bad of [
      LINK.replace("accounts.google.com", "accounts.google.com.evil.example"), LINK.replace("https:", "http:"), LINK.replace("/o/oauth2/auth", "/o/oauth2/other"),
      LINK.replace(AGY_OAUTH_CLIENT_ID, "1-other.apps.googleusercontent.com"), LINK.replace(encodeURIComponent(AGY_OAUTH_REDIRECT), encodeURIComponent("https://evil.example/cb")),
      LINK.replace("https://", "https://user@"), LINK.replace("accounts.google.com", "accounts.google.com:8443"), "not a url", "",
    ]) expect(checkedGoogleLink(bad), bad).toBeNull();
  });
  it("refuses a link without PKCE (code_challenge and code_challenge_method=S256)", () => {
    for (const bad of [LINK.replace("&code_challenge=abc", ""), LINK.replace("&code_challenge_method=S256", ""), LINK.replace("code_challenge_method=S256", "code_challenge_method=plain"),
      LINK.replace("&code_challenge=abc", "&code_challenge="), LINK.replace("&code_challenge_method=S256", "&code_challenge_method=")]) expect(checkedGoogleLink(bad), bad).toBeNull();
  });
  it("reads the OSC 8 target out of terminal output", () => {
    expect(osc8Link(osc(LINK))).toBe(LINK);
    expect(osc8Link("plain text, no link")).toBeNull();
  });
});

describe("start: the link is shown once per bot and the pty is held", () => {
  it("shows the checked link, holds the pty, and a second start re-shows it without a second pty", async () => {
    const bot = store.createBot(), holds = new AgySigninHolds(), lines: string[] = [];
    let launches = 0;
    const pty = fakePty(osc(LINK));
    const starter = new AgySigninStarter({ holds, say: (_id, text) => lines.push(text), launch: () => { launches++; return pty.child; } });
    expect(await starter.start(bot.id)).toBe("started");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(LINK);
    expect(holds.has(bot.id)).toBe(true);
    expect(await starter.start(bot.id)).toBe("pending");
    expect(launches).toBe(1);
    expect(lines).toHaveLength(2);
    holds.drop(bot.id);
  });
  it("shows nothing and holds nothing when the link is not Google's", async () => {
    const holds = new AgySigninHolds(), lines: string[] = [];
    const starter = new AgySigninStarter({ holds, say: (_id, text) => lines.push(text), launch: () => fakePty(osc("https://evil.example/o/oauth2/auth")).child });
    expect(await starter.start("bot-x")).toBe("failed");
    expect(lines.join("\n")).not.toContain("evil.example");
    expect(holds.has("bot-x")).toBe(false);
  });
  it("ends a sign-in nobody finishes after its time, dropping the hold", async () => {
    const holds = new AgySigninHolds(), lines: string[] = [];
    const starter = new AgySigninStarter({ holds, say: (_id, text) => lines.push(text), ttlMs: 20, launch: () => fakePty(osc(LINK)).child });
    await starter.start("bot-y");
    await new Promise((done) => setTimeout(done, 80));
    expect(holds.has("bot-y")).toBe(false);
    expect(starter.has("bot-y")).toBe(false);
  });
});

describe("the driver's gate", () => {
  it("runs a signed-in bot's turn, and starts the sign-in instead for a bot with no token (on a home only)", async () => {
    const started: string[] = [];
    const starter = configureAgySignin((id, text) => { started.push(`${id}:${text}`); });
    vi.spyOn(starter, "start").mockImplementation(async () => "started");
    const state = (signedIn: boolean) => async () => ({ tombstoned: false, engines: { antigravity: { mode: "oauth" as const, signedIn, expiresAt: null } } });
    expect(await agySigninRequired("bot-1", state(false))).toBeNull(); // not a home
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    expect(await agySigninRequired("bot-1", state(true))).toBeNull();
    expect(await agySigninRequired(undefined, state(false))).toBeNull();
    expect(await agySigninRequired("bot-1", async () => { throw new Error("unreadable"); })).toBeNull();
    expect(await agySigninRequired("bot-1", state(false))).toMatch(/Sign in to Google/);
    expect(starter.start).toHaveBeenCalledTimes(1);
  });
});

describe("the code is never stored (fallback end to end, real store)", () => {
  it("through its own route: found in no file under the data folder and nowhere printed, written once to the pty", async () => {
    const bot = store.createBot(), holds = new AgySigninHolds();
    const say = (text: string) => { store.appendMessage(bot.threadId, murageLine({ role: "bot", kind: "text", text })); };
    const pty = fakePty(osc(LINK));
    await new AgySigninStarter({ holds, say: (_id, text) => say(text), launch: () => pty.child }).start(bot.id);
    const reply = await acceptSigninCode({ cloudHome: true, scope: "owner-desktop", botId: bot.id, holds, readBody: async () => ({ code: CODE }), appendLine: say });
    expect(reply.status).toBe(200);
    expect(JSON.stringify(reply.body)).not.toContain(CODE);
    expect(pty.written()).toBe(`${CODE}\r`);
    expect(holds.has(bot.id)).toBe(false);
    const thread = JSON.stringify(store.newestMessages(bot.threadId, 50).messages);
    expect(thread).toContain("Code entered");
    expect(thread).not.toContain(CODE);
    const files = filesUnder(DATA_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = readFileSync(file);
      expect(bytes.includes(CODE), file).toBe(false);
      expect(bytes.includes(Buffer.from(CODE, "utf16le")), file).toBe(false);
    }
    expect(printed).not.toContain(CODE);
  });
  it("pasted into /messages while a sign-in is pending: swallowed, never stored, never forwarded, pty untouched", () => {
    const bot = store.createBot(), holds = new AgySigninHolds();
    let wrote = false;
    holds.hold(bot.id, () => { wrote = true; return true; });
    const engine = vi.fn();
    const swallowed = swallowPastedCode({ cloudHome: true, botId: bot.id, text: CODE, holds, appendLine: (text) => { store.appendMessage(bot.threadId, murageLine({ role: "bot", kind: "text", text })); } });
    if (!swallowed) engine(CODE); // what the rest of the /messages route would do
    expect(swallowed).toBe(true);
    expect(engine).not.toHaveBeenCalled();
    expect(wrote).toBe(false);
    expect(holds.has(bot.id)).toBe(true);
    expect(JSON.stringify(store.newestMessages(bot.threadId, 50).messages)).toContain("sign-in box");
    for (const file of filesUnder(DATA_DIR)) expect(readFileSync(file).includes(CODE), file).toBe(false);
    expect(printed).not.toContain(CODE);
  });
  it("a code-shaped ordinary message with NO sign-in pending goes through untouched", () => {
    const bot = store.createBot(), holds = new AgySigninHolds();
    const token = "Zx9KqLm2VbN7cT4wRs8YhJd3"; // 24 token-like characters
    const lines: string[] = [];
    expect(swallowPastedCode({ cloudHome: true, botId: bot.id, text: token, holds, appendLine: (t) => lines.push(t) })).toBe(false);
    expect(swallowPastedCode({ cloudHome: true, botId: bot.id, text: CODE, holds, appendLine: (t) => lines.push(t) })).toBe(false);
    expect(lines).toEqual([]);
    // another bot's pending sign-in does not catch this bot's message either
    holds.hold("other-bot", () => true);
    expect(swallowPastedCode({ cloudHome: true, botId: bot.id, text: token, holds, appendLine: (t) => lines.push(t) })).toBe(false);
    expect(lines).toEqual([]);
  });
  it("the code route answers 404 off a home or to anyone but the owner's desktop, and refuses a bad shape", async () => {
    const holds = new AgySigninHolds();
    holds.hold("b", () => true);
    const call = (cloudHome: boolean, scope: string | undefined, code: unknown) => acceptSigninCode({ cloudHome, scope, botId: "b", holds, readBody: async () => ({ code }), appendLine: () => {} });
    expect((await call(false, "owner-desktop", CODE)).status).toBe(404);
    expect((await call(true, "owner-phone", CODE)).status).toBe(404);
    expect((await call(true, "owner-desktop", "short")).status).toBe(400);
    expect(holds.has("b")).toBe(true);
    expect((await call(true, "owner-desktop", CODE)).status).toBe(200);
    expect((await call(true, "owner-desktop", CODE)).status).toBe(409);
  });
});
