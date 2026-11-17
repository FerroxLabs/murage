// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-NOROUTE-1019 T1-T7 (design rev 2.2). A page load the server cannot serve gets a self-contained HTML setup page
// (503), never {"error":"no route"}. Every other request keeps the JSON 404. Pure: no server, no files, no network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSetupPageResponder, isPageNavigation, pickLanguage, setupPageHtml, UI_GATE_TEXT } from "./static-ui-setup-page.ts";

const ENOENT = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
const NAV = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" };

function fakeRes() {
  const r = {
    status: 0, headers: {} as Record<string, string>, body: undefined as string | undefined, ended: false,
    writeHead(status: number, headers: Record<string, string | number>) { r.status = status; r.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])); return r; },
    end(body?: string | Buffer) { r.body = body === undefined ? "" : String(body); r.ended = true; },
  };
  return r;
}
const req = (url: string, headers: Record<string, string> = NAV, method = "GET") => ({ method, url, headers });
function make(over: Partial<Parameters<typeof createSetupPageResponder>[0]> = {}) {
  const clock = { t: 1_000_000 };
  const logs: string[] = [];
  const responder = createSetupPageResponder({ now: () => clock.t, platform: "linux", log: (l) => logs.push(l), logLink: true, ...over });
  const get = (url = "/", headers: Record<string, string> = NAV, method = "GET", err: unknown = ENOENT) => {
    const res = fakeRes();
    const handled = responder.respond(req(url, headers, method) as never, res as never, err);
    return { handled, res };
  };
  return { clock, logs, responder, get };
}

describe("T1 a page navigation with no index gets the setup page, never JSON", () => {
  it.each([
    ["sec-fetch-dest document", NAV],
    ["accept text/html with no sec-fetch headers", { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" }],
  ])("%s", (_name, headers) => {
    const { handled, res } = make().get("/", headers);
    expect(handled).toBe(true);
    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["retry-after"]).toBe("3");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(res.body).toContain('<meta http-equiv="refresh" content="3">');
    expect(res.body).not.toMatch(/"error"|no route/);
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(res.body!)));
  });
  it("HEAD gets the same status and headers with an empty body", () => {
    const { handled, res } = make().get("/", NAV, "HEAD");
    expect(handled).toBe(true);
    expect(res.status).toBe(503);
    expect(res.body).toBe("");
  });
});

describe("T2 everything that is not a page navigation keeps the JSON 404", () => {
  it.each([
    ["accept json", { accept: "application/json" }, "GET", "/"],
    ["dest script", { "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors", accept: "*/*" }, "GET", "/assets/a.js"],
    ["bare */*", { accept: "*/*" }, "GET", "/"],
    ["no headers at all", {}, "GET", "/"],
    ["dest iframe", { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", accept: "text/html" }, "GET", "/"],
    ["conflicting: dest document, mode cors", { "sec-fetch-dest": "document", "sec-fetch-mode": "cors", accept: "text/html" }, "GET", "/"],
    ["conflicting: dest empty, accept html", { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", accept: "text/html" }, "GET", "/"],
    ["text/html;q=0", { accept: "text/html;q=0, application/json" }, "GET", "/"],
    ["only sec-fetch-mode present", { "sec-fetch-mode": "navigate", accept: "text/html" }, "GET", "/"],
    ["only sec-fetch-site present", { "sec-fetch-site": "none", accept: "text/html" }, "GET", "/"],
    ["dest style", { "sec-fetch-dest": "style", accept: "text/html" }, "GET", "/"],
    ["api path", NAV, "GET", "/api/x"],
    ["POST", NAV, "POST", "/"],
  ])("%s", (_name, headers, method, url) => {
    const { handled, res } = make().get(url, headers as Record<string, string>, method);
    expect(handled).toBe(false);
    expect(res.ended).toBe(false);
  });
  it("only sec-fetch-dest present: document is a navigation, anything else is not", () => {
    expect(isPageNavigation("GET", "/", { "sec-fetch-dest": "document" })).toBe(true);
    expect(isPageNavigation("GET", "/", { "sec-fetch-dest": "image" })).toBe(false);
  });
});

describe("T3 the language comes from Accept-Language", () => {
  it("picks the first supported primary subtag, else English", () => {
    expect(pickLanguage("de-DE,de;q=0.9")).toBe("de");
    expect(pickLanguage("zz")).toBe("en");
    expect(pickLanguage(undefined)).toBe("en");
    expect(pickLanguage("xx, fr;q=0.4, ja;q=0.8")).toBe("fr"); // header order, not q order (design 3.1)
    expect(pickLanguage("fr;q=0, pt-BR")).toBe("pt");
    expect(pickLanguage("zh-CN")).toBe("zh");
  });
  it("the page is German for a German window and carries the lang attribute", () => {
    const { res } = make().get("/", { ...NAV, "accept-language": "de-DE,de;q=0.9" });
    expect(res.body).toContain(UI_GATE_TEXT.de!.title);
    expect(res.body).toContain('<html lang="de">');
    expect(Object.keys(UI_GATE_TEXT).sort()).toEqual(["de", "en", "es", "fr", "hi", "ja", "pt", "zh"]);
  });
});

describe("T4 nothing request-derived reaches the page", () => {
  it.each(['/x"><script>alert(1)</script>', "//evil.example/x", "/\\evil", '/a?b=1&c="x"', "/deep/route?x=1"])("%s", (url) => {
    const { handled, res } = make().get(url);
    expect(handled).toBe(true);
    expect(res.body).not.toContain("<script");
    expect(res.body).toContain('id="retry" href=""');
    const attributes = [...res.body!.matchAll(/\s[\w-]+="([^"]*)"/g)].map((m) => m[1]!);
    for (const value of attributes) expect(value).not.toMatch(/evil|alert|https?:|\/\//);
    expect(res.body).not.toContain("evil.example");
  });
  it("setupPageHtml has no script and no request data", () => {
    const html = setupPageHtml({ lang: "en", updating: false, refreshS: 3, logLink: true });
    expect(html).not.toContain("<script");
    expect(html).toContain('<a class="b p" id="retry" href="">');
  });
});

describe("T5 refresh interval", () => {
  it("is 3 s for two minutes after the first unservable request, then 10 s, and resets when the index is served", () => {
    const { clock, get, responder } = make();
    const refresh = () => /content="(\d+)"/.exec(get().res.body!)![1];
    expect(refresh()).toBe("3");
    clock.t += 119_000;
    expect(refresh()).toBe("3");
    clock.t += 2_000; // 121 s after the first
    expect(refresh()).toBe("10");
    expect(get().res.headers["retry-after"]).toBe("10");
    responder.served();
    expect(refresh()).toBe("3");
  });
});

describe("T6 the log link", () => {
  it("is present for the desktop child and absent for a Cloud home", () => {
    const withLink = make({ logLink: true }).get().res.body!;
    expect(withLink).toContain('href="murage-open-log:now"');
    expect(withLink).toContain('target="_blank" rel="noopener"');
    expect(make({ logLink: false }).get().res.body).not.toContain("murage-open-log");
  });
});

describe("T7 the installer check never blocks a response", () => {
  afterEach(() => vi.useRealTimers());
  const SETUP_EXE = '"Murage-1.0.19-setup.exe","4242","Console","1","9,000 K"\r\n';
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  it("a stubbed installer shows the updating line on the next response after the refresh interval, and is logged", async () => {
    const listProcesses = vi.fn(async () => SETUP_EXE);
    const { clock, get, logs } = make({ platform: "win32", listProcesses });
    const first = get().res.body!;
    expect(first).not.toContain(UI_GATE_TEXT.en!.updating);
    expect(first).toContain(UI_GATE_TEXT.en!.body);
    expect(listProcesses).toHaveBeenCalledTimes(1);
    await flush();
    clock.t += 10_000;
    const second = get().res.body!;
    expect(second).toContain(UI_GATE_TEXT.en!.updating);
    expect(logs.join("\n")).toMatch(/served the setup page.*installer is running/);
  });
  it("a hung tasklist is single-flight, times out after 4 s and never delays a response", async () => {
    vi.useFakeTimers();
    const listProcesses = vi.fn(() => new Promise<string>(() => {}));
    const { clock, get } = make({ platform: "win32", listProcesses });
    expect(get().handled).toBe(true);
    clock.t += 10_000;
    expect(get().handled).toBe(true);
    expect(listProcesses).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_100);
    clock.t += 10_000;
    expect(get().handled).toBe(true);
    expect(listProcesses).toHaveBeenCalledTimes(2);
  });
  it("on any other platform tasklist is never called", () => {
    const listProcesses = vi.fn(async () => SETUP_EXE);
    const { clock, get } = make({ platform: "darwin", listProcesses });
    get(); clock.t += 20_000; get();
    expect(listProcesses).not.toHaveBeenCalled();
  });
  it("a failing tasklist counts as no installer", async () => {
    const { clock, get } = make({ platform: "win32", listProcesses: async () => { throw new Error("boom"); } });
    get(); await flush(); clock.t += 10_000;
    expect(get().res.body).not.toContain(UI_GATE_TEXT.en!.updating);
  });
});

describe("the reason line", () => {
  it("is logged once per reason per interval, without file contents", () => {
    const { get, logs } = make();
    get(); get(); get();
    expect(logs.filter((l) => l.startsWith("static ui: served the setup page"))).toHaveLength(1);
    expect(logs[0]).toContain("missing ENOENT");
  });
});
