// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 (Fable, Sean's Mac): after the engine's idle exit, its relaunch restored the saved
// session before the first command answered, with a real navigation and a 500 ms sleep for
// EVERY origin holding storage (agent-browser 0.36.0 state.rs load_state). A used profile
// with many origins ran past the 20 s command bound. The store is now split: the engine
// restores cookies at launch, and each origin's storage goes back on the bot's first visit.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decryptEngineData, encryptEngineData, prepareBrowserRestore, restoreScript } from "./browser-restore-store.ts";
import { createNativeBrowser } from "./browser-native-relay.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const KEY = "a".repeat(64);
const SESSION = "s-restore";
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) removeTempDirSync(dir); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "murage-restore-")); directories.push(dir); return dir; };
const spec = (home: string, extra: Record<string, string> = {}) => ({ command: "engine", args: [], env: {
  HOME: home, USERPROFILE: home, AGENT_BROWSER_SOCKET_DIR: home, AGENT_BROWSER_SESSION: SESSION, AGENT_BROWSER_RESTORE: SESSION,
  AGENT_BROWSER_RESTORE_SAVE: "auto", AGENT_BROWSER_ENCRYPTION_KEY: KEY, ...extra } });
const sessions = (home: string) => join(home, ".agent-browser", "sessions");
const origin = (i: number) => `http://o${i}.localhost:4100`;
let saves = 0;
const COOKIE = { name: "sid", value: "signed-in", domain: "o0.localhost", path: "/", expires: -1, size: 0, httpOnly: true, secure: false, session: true, sameSite: "Lax" };
function writeEngineState(home: string, origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>, name = `${SESSION}-run1.json.enc`) {
  mkdirSync(sessions(home), { recursive: true });
  const path = join(sessions(home), name);
  writeFileSync(path, encryptEngineData(Buffer.from(JSON.stringify({ cookies: [COOKIE], origins: origins.map(o => ({ ...o, sessionStorage: [] })) })), KEY));
  // Each save is newer than the last, as the engine's are.
  const at = new Date(Date.now() + 1000 * ++saves);
  utimesSync(path, at, at);
  return path;
}
const readEngineState = (path: string) => JSON.parse(decryptEngineData(readFileSync(path), KEY).toString("utf8")) as { cookies: unknown[]; origins: unknown[] };
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ origin: origin(i), localStorage: [{ name: "token", value: `v${i}` }] }));

describe("the saved session is split before the engine starts", () => {
  it("uses the engine's own file encryption: a 12-byte nonce, AES-256-GCM, the tag last", () => {
    const sealed = encryptEngineData(Buffer.from("hello"), KEY);
    expect(sealed.length).toBe(12 + 5 + 16);
    expect(decryptEngineData(sealed, KEY).toString()).toBe("hello");
    expect(() => decryptEngineData(sealed, "b".repeat(64))).toThrow();
  });

  it("leaves the engine only the cookies to restore at launch, and keeps every origin's storage", () => {
    const home = temp();
    const file = writeEngineState(home, many(120));
    const logged: string[] = [];
    const restore = prepareBrowserRestore(spec(home), line => logged.push(line))!;
    const state = readEngineState(file);
    expect(state.cookies).toEqual([COOKIE]);
    expect(state.origins).toEqual([]);
    expect(restore.origins).toBe(120);
    expect(restore.pending(origin(57))).toEqual({ localStorage: [{ name: "token", value: "v57" }], sessionStorage: [] });
    expect(logged.join("\n")).toMatch(/restore store: 120 origins with saved storage, 1 cookies; .* \(prepared in \d+ ms\)/);
    // Murage's half is not a name the engine restores from.
    expect(readdirSync(sessions(home)).filter(name => name.startsWith(`${SESSION}-`))).toEqual([`${SESSION}-run1.json.enc`]);
  });

  it("takes in the engine's next save: newer storage wins, an origin the site emptied goes, an unvisited one stays", () => {
    const home = temp();
    writeEngineState(home, many(5));
    const first = prepareBrowserRestore(spec(home), () => {})!;
    // This run the bot visited o1 (it changed) and o2 (the site signed out and emptied it).
    first.restored(origin(1)); first.restored(origin(2));
    // The engine's save at its idle exit: o1 changed, o2 missing, a new o9; o0, o3, o4 never opened this run.
    writeEngineState(home, [{ origin: origin(1), localStorage: [{ name: "token", value: "newer" }] }, { origin: origin(9), localStorage: [{ name: "token", value: "v9" }] }], `${SESSION}-run2.json.enc`);
    const second = prepareBrowserRestore(spec(home), () => {})!;
    expect(second.pending(origin(1))?.localStorage).toEqual([{ name: "token", value: "newer" }]);
    expect(second.pending(origin(2))).toBeUndefined();
    expect(second.pending(origin(9))?.localStorage).toEqual([{ name: "token", value: "v9" }]);
    for (const kept of [0, 3, 4]) expect(second.pending(origin(kept))?.localStorage).toEqual([{ name: "token", value: `v${kept}` }]);
    expect(second.origins).toBe(5);
  });

  it("drops nothing when the engine has not saved since the split", () => {
    const home = temp();
    writeEngineState(home, many(3));
    const first = prepareBrowserRestore(spec(home), () => {})!;
    first.restored(origin(0));
    // The engine stopped without saving: its file is still the cookies-only one Murage wrote.
    const again = prepareBrowserRestore(spec(home), () => {})!;
    expect(again.origins).toBe(3);
    expect(again.pending(origin(0))).toBeDefined();
  });

  it("drops an origin the owner reached themselves once the engine's next save no longer holds it", () => {
    const home = temp();
    writeEngineState(home, many(2));
    const first = prepareBrowserRestore(spec(home), () => {})!;
    first.passed(origin(0));
    expect(first.pending(origin(0))).toBeUndefined();
    // The owner signed out there: the engine's save has no storage for it, so Murage's older copy goes.
    writeEngineState(home, [], `${SESSION}-run2.json.enc`);
    const second = prepareBrowserRestore(spec(home), () => {})!;
    expect(second.pending(origin(0))).toBeUndefined();
    expect(second.pending(origin(1))).toBeDefined();
  });

  it("forgets an origin not seen in 90 days, and keeps one seen since", () => {
    const home = temp();
    const day = 24 * 60 * 60 * 1000;
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    writeEngineState(home, many(3));
    prepareBrowserRestore(spec(home), () => {});
    // Sixty days on, the engine saves o1 again.
    now.mockReturnValue(start + 60 * day);
    writeEngineState(home, [{ origin: origin(1), localStorage: [{ name: "token", value: "again" }] }], `${SESSION}-run2.json.enc`);
    prepareBrowserRestore(spec(home), () => {});
    // Ninety-one days after the first save: o0 and o2 were not seen since.
    now.mockReturnValue(start + 91 * day);
    const logged: string[] = [];
    const later = prepareBrowserRestore(spec(home), line => logged.push(line))!;
    expect(later.origins).toBe(1);
    expect(later.pending(origin(1))?.localStorage).toEqual([{ name: "token", value: "again" }]);
    expect(later.pending(origin(0))).toBeUndefined();
    expect(logged.join("\n")).toMatch(/restore store: dropped 2 origins/);
  });

  it("keeps at most the 500 most recently seen origins", () => {
    const home = temp();
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    writeEngineState(home, many(300));
    prepareBrowserRestore(spec(home), () => {});
    now.mockReturnValue(start + 1000);
    const newer = Array.from({ length: 300 }, (_, i) => ({ origin: origin(1000 + i), localStorage: [{ name: "token", value: `n${i}` }] }));
    writeEngineState(home, newer, `${SESSION}-run2.json.enc`);
    const logged: string[] = [];
    const capped = prepareBrowserRestore(spec(home), line => logged.push(line))!;
    expect(capped.origins).toBe(500);
    for (let i = 0; i < 300; i++) expect(capped.pending(origin(1000 + i))).toBeDefined();
    expect(Array.from({ length: 300 }, (_, i) => capped.pending(origin(i))).filter(Boolean)).toHaveLength(200);
    expect(logged.join("\n")).toMatch(/restore store: dropped 100 origins/);
  });

  it("never logs any part of a saved session it cannot read", () => {
    const home = temp();
    mkdirSync(sessions(home), { recursive: true });
    writeFileSync(join(sessions(home), `${SESSION}-run1.json`), "SECRET-TOKEN-1234 not json");
    const logged: string[] = [];
    prepareBrowserRestore(spec(home), line => logged.push(line));
    expect(logged.join("\n")).toMatch(/saved session could not be read/);
    expect(logged.join("\n")).not.toMatch(/SECRET|TOKEN|1234/);
  });

  it("gives up on an origin for this run after one failed attempt, and keeps its storage for the next", () => {
    const home = temp();
    writeEngineState(home, many(1));
    const first = prepareBrowserRestore(spec(home), () => {})!;
    expect(first.waiting()).toBe(true);
    first.abandoned(origin(0));
    expect(first.pending(origin(0))).toBeUndefined();
    expect(first.waiting()).toBe(false);
    writeEngineState(home, [], `${SESSION}-run2.json.enc`);
    expect(prepareBrowserRestore(spec(home), () => {})!.pending(origin(0))).toBeDefined();
  });

  it("does nothing for a browser that keeps no saved state", () => {
    const home = temp();
    writeEngineState(home, many(2));
    expect(prepareBrowserRestore(spec(home, { AGENT_BROWSER_RESTORE_SAVE: "never" }), () => {})).toBeUndefined();
    expect(prepareBrowserRestore(spec(temp()), () => {})).toBeUndefined();
  });
});

describe("the restore script", () => {
  const page = (at: string) => {
    const store = (): Storage & { data: Record<string, string> } => {
      const data: Record<string, string> = {};
      return { data, setItem: (k: string, v: string) => { data[k] = v; } } as never;
    };
    const ctx = { location: { origin: at }, localStorage: store(), sessionStorage: store() };
    return ctx;
  };
  it("puts the storage back only on its own origin", () => {
    const script = restoreScript(origin(3), { localStorage: [{ name: "token", value: "v3" }], sessionStorage: [{ name: "tab", value: "t" }] });
    const right = page(origin(3));
    expect(runInNewContext(script, right)).toBe("murage-restore-done");
    expect(right.localStorage.data).toEqual({ token: "v3" });
    expect(right.sessionStorage.data).toEqual({ tab: "t" });
    const wrong = page(origin(4));
    expect(runInNewContext(script, wrong)).toBe("murage-restore-elsewhere");
    expect(wrong.localStorage.data).toEqual({});
  });
});

// A stand-in engine behind the relay's MCP client: it keeps one page and each origin's storage.
const FAKE_MCP = `const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const dir = process.argv[2];
fs.writeFileSync(path.join(dir, ${JSON.stringify(SESSION)} + ".pid"), String(process.pid));
let url = "about:blank";
const storage = {};
const calls = [];
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result = {};
    if (message.method === "tools/call") {
      const { name, arguments: args = {} } = message.params;
      calls.push({ name, url: args.url, selector: args.selector });
      // redirect.json: addresses that load somewhere else, as a site signed out sends every page to its sign-in.
      const redirects = fs.existsSync(path.join(dir, "redirect.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "redirect.json"), "utf8")) : {};
      if (name === "agent_browser_open" || (name === "agent_browser_tab_new" && args.url)) url = redirects[new URL(args.url).origin] ?? args.url;
      if (name === "agent_browser_click") url = args.selector;
      if (name === "agent_browser_get_url") result = text({ url });
      else if (name === "agent_browser_eval") {
        const origin = new URL(url).origin;
        const local = (storage[origin] ??= {});
        const store = { setItem: (k, v) => { local[k] = v; } };
        result = text(String(vm.runInNewContext(args.script, { location: { origin }, localStorage: store, sessionStorage: { setItem() {} } })));
      } else result = text({ ok: true, name });
      fs.writeFileSync(path.join(dir, "fake.json"), JSON.stringify({ calls, storage }));
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`;
function fakeEngine(origins: number) {
  const home = temp();
  writeEngineState(home, many(origins));
  const script = join(home, "fake-mcp.cjs");
  writeFileSync(script, FAKE_MCP);
  const s = { ...spec(home, { PATH: process.env.PATH ?? "" }), command: process.execPath, args: [script, home] };
  const seen = () => JSON.parse(readFileSync(join(home, "fake.json"), "utf8")) as { calls: Array<{ name: string; url?: string }>; storage: Record<string, Record<string, string>> };
  return { home, native: createNativeBrowser(s), seen };
}
const open = (url: string) => ({ name: "agent_browser_open", arguments: { url } });

describe("each origin's storage goes back on the bot's first visit", () => {
  it("lands on the origin, puts its storage back, then loads the page the bot asked for; once per run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { native, seen } = fakeEngine(120);
    await native.request("tools/call", open(`${origin(57)}/inbox`));
    expect(seen().storage[origin(57)]).toEqual({ token: "v57" });
    expect(seen().calls.map(c => [c.name, c.url])).toEqual([
      ["agent_browser_open", `${origin(57)}/`], ["agent_browser_eval", undefined], ["agent_browser_open", `${origin(57)}/inbox`], ["agent_browser_get_url", undefined]]);
    // Its second visit this run restores nothing again, so what the site changed stays.
    const before = seen().calls.length;
    await native.request("tools/call", open(`${origin(57)}/settings`));
    expect(seen().calls.slice(before).map(c => c.name)).toEqual(["agent_browser_open", "agent_browser_get_url"]);
    await native.close();
  }, 20_000);

  it("restores an origin the bot reached through a link, then loads that page again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { native, seen } = fakeEngine(3);
    await native.request("tools/call", { name: "agent_browser_click", arguments: { selector: `${origin(2)}/welcome` } });
    expect(seen().storage[origin(2)]).toEqual({ token: "v2" });
    expect(seen().calls.map(c => [c.name, c.url])).toEqual([
      ["agent_browser_click", undefined], ["agent_browser_get_url", undefined], ["agent_browser_eval", undefined], ["agent_browser_open", `${origin(2)}/welcome`]]);
    await native.close();
  }, 20_000);

  it("opens a new tab blank first, so the bot's current page is never navigated away", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { native, seen } = fakeEngine(2);
    await native.request("tools/call", { name: "agent_browser_tab_new", arguments: { url: `${origin(1)}/a` } });
    expect(seen().calls.map(c => [c.name, c.url])).toEqual([
      ["agent_browser_tab_new", undefined], ["agent_browser_open", `${origin(1)}/`], ["agent_browser_eval", undefined], ["agent_browser_open", `${origin(1)}/a`], ["agent_browser_get_url", undefined]]);
    await native.close();
  }, 20_000);

  it("never puts saved storage over an origin the owner reached while holding control", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { native, seen } = fakeEngine(2);
    await native.request("tools/call", { name: "agent_browser_get_url", arguments: {} });
    native.ownerReached!(`${origin(1)}/signed-in-fresh`);
    await native.request("tools/call", open(`${origin(1)}/x`));
    expect(seen().storage[origin(1)]).toBeUndefined();
    await native.close();
  }, 20_000);

  it("tries an origin that always sends the bot elsewhere once per run, then stops landing and polling", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { home, native, seen } = fakeEngine(1);
    writeFileSync(join(home, "redirect.json"), JSON.stringify({ [origin(0)]: "http://sign-in.localhost:4100/" }));
    await native.request("tools/call", open(`${origin(0)}/inbox`));
    expect(seen().calls.map(c => [c.name, c.url])).toEqual([
      ["agent_browser_open", `${origin(0)}/`], ["agent_browser_eval", undefined], ["agent_browser_open", `${origin(0)}/inbox`], ["agent_browser_get_url", undefined]]);
    expect(seen().storage["http://sign-in.localhost:4100"] ?? {}).toEqual({});
    // Its next visit this run is a plain open: no landing on "/", no restore, no address check.
    const before = seen().calls.length;
    await native.request("tools/call", open(`${origin(0)}/inbox`));
    expect(seen().calls.slice(before).map(c => [c.name, c.url])).toEqual([["agent_browser_open", `${origin(0)}/inbox`]]);
    await native.close();
  }, 20_000);
});
