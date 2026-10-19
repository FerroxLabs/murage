// B3 WP5: the engine sign-in terminal. Real xterm parser, fake bridge; no DOM.
import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";

import { ENGINE_LOGIN_AUTH_HOSTS as MAIN_HOSTS, checkAuthUrl as mainCheck } from "../../electron/cloud-home-engine-login.mjs";
import {
  CLOSE_COPY, ENGINE_LOGIN_AUTH_HOSTS, LINK_REFUSED, authLinkProvider, checkAuthUrl, findAuthLinks, installTerminalGuards, startEngineLoginSession,
  type EngineLoginBridge,
} from "./engine-login-terminal";

const written = (terminal: Terminal, data: string | Uint8Array) => new Promise<void>((resolve) => terminal.write(data, resolve));
const lineText = (terminal: Terminal, row: number) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "";
const bel = "\x07";

describe("OSC 52 and OSC 8 are swallowed", () => {
  it("OSC 52 (clipboard write) is consumed: the handler runs, nothing is printed, no clipboard write is attempted", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const terminal = new Terminal({ cols: 80, rows: 5, allowProposedApi: false });
      const swallowed: number[] = [];
      installTerminalGuards(terminal, (code) => swallowed.push(code));
      await written(terminal, `before\x1b]52;c;${btoa("stolen")}${bel}after\r\n`);
      await written(terminal, `x\x1b]52;c;${btoa("stolen")}\x1b\\y\r\n`);
      expect(swallowed).toEqual([52, 52]);
      expect(lineText(terminal, 0)).toBe("beforeafter");
      expect(lineText(terminal, 1)).toBe("xy");
      expect(writeText).not.toHaveBeenCalled();
      terminal.dispose();
    } finally { vi.unstubAllGlobals(); }
  });

  it("OSC 8 (hyperlink) is consumed: the label prints as plain text and the hidden target never becomes a link", async () => {
    const terminal = new Terminal({ cols: 80, rows: 5, allowProposedApi: false });
    const swallowed: number[] = [];
    installTerminalGuards(terminal, (code) => swallowed.push(code));
    await written(terminal, `\x1b]8;;https://evil.example/phish${bel}Sign in with Claude\x1b]8;;${bel}\r\n`);
    expect(swallowed).toEqual([8, 8]);
    expect(lineText(terminal, 0)).toBe("Sign in with Claude");
    // The cell carries no hyperlink id (xterm keeps it in the extended attributes).
    const cell = terminal.buffer.active.getLine(0)!.getCell(0)!;
    expect((cell as unknown as { extended?: { urlId?: number } }).extended?.urlId ?? 0).toBe(0);
    // and nothing in the buffer offers the hidden target as a link
    const rows = [{ text: lineText(terminal, 0), isWrapped: false }];
    expect(findAuthLinks(rows, 1)).toEqual([]);
    terminal.dispose();
  });

  it("without the guard xterm's own handler would take the OSC 8: the guard is what makes the difference", async () => {
    const plain = new Terminal({ cols: 80, rows: 5 });
    await written(plain, `\x1b]8;;https://evil.example/phish${bel}label\x1b]8;;${bel}`);
    const cell = plain.buffer.active.getLine(0)!.getCell(0)!;
    const urlId = (cell as unknown as { extended?: { urlId?: number } }).extended?.urlId ?? 0;
    expect(urlId).toBeGreaterThan(0);
    plain.dispose();
  });

  it("dispose removes the guards", async () => {
    const terminal = new Terminal({ cols: 80, rows: 5 });
    const swallowed: number[] = [];
    installTerminalGuards(terminal, (code) => swallowed.push(code)).dispose();
    await written(terminal, `a\x1b]52;c;eA==${bel}b`);
    expect(swallowed).toEqual([]);
    terminal.dispose();
  });
});

describe("the vendor auth-host allow-list", () => {
  const SEEN = ["https://auth.openai.com/codex/device", "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&state=xyz",
    "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234", "https://www.kimi.ai/code/authorize_device?user_code=ABCD-1234"];
  it("allows the URLs the CLIs really printed, in the renderer and in main", () => {
    for (const url of SEEN) { expect(checkAuthUrl(url)).toBe(url); expect(mainCheck(url)).toBe(url); }
  });
  it("is the same list in the renderer and in main", () => {
    expect([...ENGINE_LOGIN_AUTH_HOSTS]).toEqual([...MAIN_HOSTS]);
    expect([...ENGINE_LOGIN_AUTH_HOSTS]).toEqual(["accounts.x.ai", "auth.openai.com", "claude.ai", "claude.com", "platform.claude.com", "www.kimi.ai"]);
  });
  it("refuses everything else, and agrees with main on every refusal", () => {
    for (const bad of ["https://evil.example/", "http://claude.ai/", "https://claude.ai.evil.example/", "https://evilclaude.ai/", "https://user@claude.ai/", "https://claude.ai:444/",
      "javascript:alert(1)", "https://chatgpt.com/", "https://sub.claude.ai/", "https://claude.ai/ x", "", "ftp://claude.ai/"]) {
      expect(checkAuthUrl(bad), bad).toBeNull();
      expect(mainCheck(bad), bad).toBeNull();
    }
  });
});

const pad = (text: string, cols = 40) => text.padEnd(cols, " ");
describe("link detection", () => {
  it("finds an allow-listed link on one row and ignores an off-list one", () => {
    const rows = [{ text: pad("Open https://auth.openai.com/codex/device now"), isWrapped: false }, { text: pad("or https://evil.example/codex/device"), isWrapped: false }];
    const links = findAuthLinks(rows, 3);
    expect(links).toEqual([{ url: "https://auth.openai.com/codex/device", start: { x: 6, y: 3 }, end: { x: 41, y: 3 } }]);
  });
  it("joins a URL the terminal soft-wrapped across rows", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
    const rows = [url.slice(0, 40), url.slice(40)].map((text, i) => ({ text: pad(text), isWrapped: i > 0 }));
    const [link] = findAuthLinks(rows, 1);
    expect(link.url).toBe(url);
    expect(link.start).toEqual({ x: 1, y: 1 });
    expect(link.end).toEqual({ x: url.length - 40, y: 2 });
  });
  it("joins a URL the CLI broke itself (no spaces on the continuation), but not a prompt that follows", () => {
    const rows = [pad("https://claude.com/cai/oauth/authorize?code=tru"), pad("e&client_id=abc"), pad(""), pad("Paste code here if prompted >")].map((text) => ({ text, isWrapped: false }));
    const links = findAuthLinks(rows, 1);
    expect(links.map((l) => l.url)).toEqual(["https://claude.com/cai/oauth/authorize?code=true&client_id=abc"]);
    expect(links[0].end).toEqual({ x: 15, y: 2 });
  });
  it("a joined URL whose host is off-list is not a link, and trailing punctuation is not part of one", () => {
    expect(findAuthLinks([{ text: pad("see https://evil.example/https://claude.ai/ "), isWrapped: false }], 1)).toEqual([]);
    const [link] = findAuthLinks([{ text: pad("(https://claude.ai/login)."), isWrapped: false }], 1);
    expect(link.url).toBe("https://claude.ai/login");
  });
  it("the xterm provider offers only allow-listed rows and hands the URL text to onActivate", async () => {
    const terminal = new Terminal({ cols: 60, rows: 6 });
    await written(terminal, "visit https://auth.openai.com/codex/device\r\nand https://evil.example/x\r\n");
    const onActivate = vi.fn();
    const provider = authLinkProvider(terminal, onActivate);
    const at = (y: number) => new Promise<unknown[] | undefined>((resolve) => provider.provideLinks(y, resolve as never));
    const first = (await at(1))!;
    expect(first).toHaveLength(1);
    expect((first[0] as { text: string }).text).toBe("https://auth.openai.com/codex/device");
    (first[0] as { activate: (e: unknown, t: string) => void }).activate({}, (first[0] as { text: string }).text);
    expect(onActivate).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
    expect(await at(2)).toBeUndefined();
    terminal.dispose();
  });
});

function fakeBridge(startResult: unknown = { ok: true, id: "s1" }) {
  const dataListeners = new Set<(p: { id: string; data: Uint8Array }) => void>();
  const closedListeners = new Set<(p: { id: string; reason: string }) => void>();
  const bridge = {
    start: vi.fn(async () => startResult),
    input: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    openLink: vi.fn(async () => ({ ok: true })),
    onData: (l: never) => { dataListeners.add(l); return () => dataListeners.delete(l); },
    onClosed: (l: never) => { closedListeners.add(l); return () => closedListeners.delete(l); },
  };
  return { bridge: bridge as unknown as EngineLoginBridge & typeof bridge, data: (p: { id: string; data: Uint8Array }) => dataListeners.forEach((l) => l(p)), closed: (p: { id: string; reason: string }) => closedListeners.forEach((l) => l(p)), listeners: () => dataListeners.size + closedListeners.size };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the session", () => {
  it("an off-list link is refused in the renderer: the bridge is never asked to open it", async () => {
    const f = fakeBridge(); const states: unknown[] = [];
    const session = startEngineLoginSession({ bridge: f.bridge, request: { homeId: "h-1", engine: "codex" }, write: () => {}, onState: (s) => states.push(s) });
    await tick();
    expect(await session.openLink("https://evil.example/codex/device")).toBe(false);
    expect(f.bridge.openLink).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ phase: "open", notice: LINK_REFUSED });
    expect(await session.openLink("https://auth.openai.com/codex/device")).toBe(true);
    expect(f.bridge.openLink).toHaveBeenCalledWith({ id: "s1", url: "https://auth.openai.com/codex/device" });
  });
  it("feeds only this session's bytes to the terminal, including bytes that race ahead of the start reply", async () => {
    const f = fakeBridge(); const out: string[] = [];
    f.bridge.start.mockImplementation(async () => { f.data({ id: "s1", data: new TextEncoder().encode("early ") }); return { ok: true, id: "s1" }; });
    startEngineLoginSession({ bridge: f.bridge, request: { homeId: "h-1", engine: "codex" }, write: (d) => out.push(new TextDecoder().decode(d)), onState: () => {} });
    await tick();
    f.data({ id: "other", data: new TextEncoder().encode("NOT MINE") });
    f.data({ id: "s1", data: new TextEncoder().encode("late") });
    expect(out.join("")).toBe("early late");
  });
  it("sends the pasted code once, with a carriage return, and ignores an empty one", async () => {
    const f = fakeBridge();
    const session = startEngineLoginSession({ bridge: f.bridge, request: { homeId: "h-1", engine: "claudeAgent" }, write: () => {}, onState: () => {} });
    await tick();
    expect(await session.sendCode("   ")).toBe(false);
    expect(await session.sendCode("  abc#def  ")).toBe(true);
    expect(f.bridge.input).toHaveBeenCalledTimes(1);
    expect(f.bridge.input).toHaveBeenCalledWith({ id: "s1", data: "abc#def\r" });
  });
  it("a refusal from main (browser session, no step-up) ends the session with its plain message and unsubscribes", async () => {
    const f = fakeBridge({ ok: false, code: "owner-desktop-required", message: "Signing an engine in needs the desktop you paired as the owner. This device can't do it." });
    const states: { phase: string; message?: string; reason?: string }[] = [];
    startEngineLoginSession({ bridge: f.bridge, request: { homeId: "h-1", engine: "codex" }, write: () => {}, onState: (s) => states.push(s) });
    await tick();
    expect(states.at(-1)).toEqual({ phase: "error", message: "Signing an engine in needs the desktop you paired as the owner. This device can't do it.", reason: "owner-desktop-required" });
    expect(f.listeners()).toBe(0);
  });
  it("the caps are reported in plain words, and a closed session stops listening", async () => {
    const f = fakeBridge(); const states: { phase: string; message?: string }[] = [];
    startEngineLoginSession({ bridge: f.bridge, request: { homeId: "h-1", engine: "claudeAgent" }, write: () => {}, onState: (s) => states.push(s) });
    await tick();
    f.closed({ id: "s1", reason: "idle-timeout" });
    expect(states.at(-1)).toMatchObject({ phase: "closed", message: CLOSE_COPY["idle-timeout"] });
    expect(CLOSE_COPY["idle-timeout"]).toMatch(/2 minutes/);
    expect(CLOSE_COPY["total-timeout"]).toMatch(/15 minutes/);
    expect(f.listeners()).toBe(0);
  });
  it("stop() before the start reply still stops the relay that then opens", async () => {
    const f = fakeBridge();
    const session = startEngineLoginSession({ bridge: f.bridge, request: { homeId: "h-1", engine: "codex" }, write: () => {}, onState: () => {} });
    session.stop();
    await tick();
    expect(f.bridge.stop).toHaveBeenCalledWith({ id: "s1" });
  });
});
