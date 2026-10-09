// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HIDDEN, redactPageOutput, redactPageOutputDeep, redactUrlForOutput, sanitizeRawHtml } from "./browser-output-redaction.ts";
import { buildCheckerRequest } from "./browser-action-checker.ts";
import { BrowserActivityStore } from "./browser-extension-activity.ts";
import { readWithBrowserAuthority, type EngineReadContext } from "./browser-extension-engine-read.ts";
import { fastestOfMs } from "./testing/timing.ts";

// The canaries: each is a value that must never leave through any of the four exits.
const CARD = "4111 1111 1111 1111";
const ARABIC_OTP = "٤٨٢٩١٦";
const SSN = "123-45-6789";
const OTP8 = "48291637";
const PASSWORD = "hunter2-correct-horse";
const PATH_VALUE = "482916";
const CANARY_NEEDLES = ["4111", "1111 1111", ARABIC_OTP, "123-45-6789", OTP8, "hunter2", PATH_VALUE];
const leaks = (text: string) => CANARY_NEEDLES.filter(needle => text.includes(needle));

const PAGE_TEXT = [
  `Card on file: ${CARD}`,
  `رمز التحقق: ${ARABIC_OTP}`,
  `SSN ${SSN}`,
  `Your code is ${OTP8}`,
  `<div contenteditable="true" aria-label="Password">${PASSWORD}</div>`,
  `Open https://bank.example/verify/${PATH_VALUE}/confirm to continue`,
].join("\n");

describe("redactPageOutput", () => {
  it("removes every canary and keeps the ordinary text", () => {
    const out = redactPageOutput(PAGE_TEXT + "\nOrder 2026 shipped on 2026-10-03 to Lisbon.");
    expect(leaks(out)).toEqual([]);
    expect(out).toContain("Open https://bank.example/verify/" + HIDDEN + "/confirm to continue");
    expect(out).toContain("Order 2026 shipped on 2026-10-03 to Lisbon.");
    expect(redactPageOutput(out)).toBe(out);
  });
  it("masks labelled values in text and JSON, and URL query values and credentials", () => {
    expect(redactPageOutput("password: hunter2 and otp=123456")).not.toMatch(/hunter2|123456/);
    expect(redactPageOutput('{"cardNumber":"4111111111111111","name":"Ann"}')).toBe(`{"cardNumber":"${HIDDEN}","name":"Ann"}`);
    expect(redactUrlForOutput("https://u:p@a.example/x?token=abcdef&lang=en#access_token=zzz")).toBe(`https://a.example/x?token=${HIDDEN}&lang=en#access_token=${HIDDEN}`);
  });
  it("handles hostile input without throwing or looping", () => {
    expect(redactPageOutput("")).toBe("");
    expect(() => redactPageOutput("1 ".repeat(200000))).not.toThrow();
    expect(() => redactPageOutput("1" + " ".repeat(100000) + "x")).not.toThrow();
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect(() => redactPageOutputDeep(cyc)).not.toThrow();
  });
});

describe("bypasses found in review", () => {
  const clean = (text: string) => { const out = redactPageOutput(text); return out; };
  it("catches cards with other separators and a card beside a year", () => {
    expect(clean("Card: 4111/1111/1111/1111")).not.toMatch(/4111|1111/);
    expect(clean("Card: \u0664\u0661\u0661\u0661\u066c\u0661\u0661\u0661\u0661\u066c\u0661\u0661\u0661\u0661\u066c\u0661\u0661\u0661\u0661")).not.toMatch(/\u0664\u0661|1111/);
    const mixed = clean("Card: 4111 1111 1111 1111 2026");
    expect(mixed).not.toContain("4111");
    expect(mixed).toContain("2026");
  });
  it("catches a code on the line after its label", () => {
    expect(clean("Your code is\n48291637")).not.toContain("48291637");
  });
  it("catches encoded and contextual URL secrets", () => {
    for (const url of ["https://a.example/verify/%34%38%32%39%31%36.html", "https://a.example/password/hunter2", "https://a.example/x?x=482+916", "https://a.example/#/verify/%34%38%32%39%31%36"])
      expect(clean("see " + url)).not.toMatch(/%34%38|hunter2|482\+916|482916/);
  });
  it("hides whole multiword labelled values and passphrases", () => {
    expect(clean("API key: hunter2")).not.toContain("hunter2");
    expect(clean("security code: abcdEFgh")).not.toContain("abcdEFgh");
    expect(clean("password: correct horse battery staple")).not.toMatch(/horse|staple/);
    expect(clean("Time: 10:30 password: hunter2")).not.toContain("hunter2");
  });
  it("hides nested editable passwords, in any language, and entity-encoded cards", () => {
    expect(clean('<div contenteditable aria-label="Password"><b>hunter2</b></div>')).not.toContain("hunter2");
    expect(clean('<div contenteditable aria-label="contrase\u00f1a"><b>hunter2</b></div>')).not.toContain("hunter2");
    expect(clean("<p>Card: &#52;111 &#49;111 &#49;111 &#49;111</p>")).not.toMatch(/111/);
  });
  it("native records keep no numeric or key-position canaries", () => {
    const out = JSON.stringify(redactPageOutputDeep({ cardNumber: 4111111111111111, otp: "48291637", ssn: "123456789", "4111 1111 1111 1111": "x", max_tokens: 4096 }));
    expect(out).not.toMatch(/4111|48291637|123456789/);
    expect(out).toContain("4096");
  });
  it("keeps years, dates, prices and plain pages", () => {
    const text = "In 2026 we updated the page on 2026-10-03, price $1234.56, see https://a.example/news/2026-10-03";
    expect(clean(text)).toBe(text);
  });
  it("runs in linear time on 2 MB of hostile markup and numbers", () => {
    for (const hostile of ["<input ".repeat(300000).slice(0, 2 * 1024 * 1024), "1 ".repeat(1_000_000), "a".repeat(2 * 1024 * 1024), "x=".repeat(1_000_000)]) {
      expect(fastestOfMs(() => redactPageOutput(hostile), 4000)).toBeLessThan(4000);
    }
  });
});

describe("the checker request", () => {
  it("carries no canary from the target, the excerpt or the destination", () => {
    const built = buildCheckerRequest({
      ownerInstruction: "Send the note", siteGrant: "granted for this task",
      action: { operation: "type", level: "L3", site: "https://bank.example", isSend: true, targetRole: "textbox", targetName: PAGE_TEXT.replace(/\n/g, " "),
        typedTextExcerpt: `my card is ${CARD}, otp ${OTP8}, ssn ${SSN}`, typedTextLength: 40, destinationUrl: `https://bank.example/verify/${PATH_VALUE}/confirm?token=abc123&x=1` },
    }, 2);
    expect(leaks(built.user)).toEqual([]);
    expect(built.user).toContain("https://bank.example/verify/" + HIDDEN + "/confirm?token&x");
  });
  it("redacts before it truncates, and cleans the role", () => {
    const built = buildCheckerRequest({ ownerInstruction: "Send", siteGrant: "g", action: { operation: "type", level: "L3", site: "https://x.example", isSend: true, targetRole: CARD, typedTextExcerpt: "x".repeat(193) + "4111111111111111" } }, 2);
    expect(built.user).not.toMatch(/4111|1111/);
  });
  it("sends nothing of an excerpt that is itself a secret value, nor its length", () => {
    const built = buildCheckerRequest({ ownerInstruction: "Pay", siteGrant: "g", action: { operation: "type", level: "L3", site: "https://shop.example", isSend: true, typedTextExcerpt: CARD, typedTextLength: 19 } }, 2);
    expect(built.user).not.toContain("1111");
    expect(built.user).not.toContain("typed text length");
  });
});

describe("the activity log", () => {
  it("writes no canary to the NDJSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "out-activity-"));
    const store = new BrowserActivityStore(dir);
    for (const target of PAGE_TEXT.split("\n")) store.record({ botId: "b1", bindingId: "bind1", taskId: "t1", site: `https://bank.example/verify/${PATH_VALUE}`, action: "click", target, fromPage: true, level: 2, decision: "free" });
    const text = readdirSync(dir).map(name => readFileSync(join(dir, name), "utf8")).join("\n");
    expect(text.length).toBeGreaterThan(0);
    expect(leaks(text)).toEqual([]);
  });
});

describe("the raw HTML read", () => {
  const read = (html: string, options: { raw?: boolean } = { raw: true }) => {
    const context: EngineReadContext = { currentUrl: "https://bank.example/home", activeHtml: async () => html, authorize: () => true, admitUrl: async () => {} };
    return readWithBrowserAuthority(options, context);
  };
  it("returns no hidden value, inline script data or data URL", async () => {
    const html = `<html><body><p>${CARD}</p><form><input type="hidden" name="csrf" value="abc-secret-xyz"><input name="city" value="Lisbon"></form>
      <script type="application/json">{"user":"${PASSWORD}","ssn":"${SSN}"}</script><img src="data:image/png;base64,AAAA${OTP8}"><div data-session="${OTP8}">hi</div>
      <meta name="csrf-token" content="${PATH_VALUE}"><!-- build ${OTP8} --></body></html>`;
    const out = (await read(html)).structuredContent.content;
    expect(leaks(out)).toEqual([]);
    expect(out).not.toMatch(/abc-secret-xyz|base64,AAAA|"user"|"ssn"/);
    expect(out).toContain("Lisbon");
  });
  it("refuses a page whose editable region is a password, so its text never returns", async () => {
    await expect(read(`<div contenteditable="true" aria-label="Password">${PASSWORD}</div>`)).rejects.toThrow(/protected/);
  });
  it("redacts canaries in text mode too", async () => {
    const out = (await read(`<p>Card on file: ${CARD}</p><p>Your code is ${OTP8}</p>`, {})).structuredContent.content;
    expect(leaks(out)).toEqual([]);
  });
  it("sanitizes whatever the MIME says, and the url, final url and errors", async () => {
    const f = (type: string, body: string, current = "https://bank.example/verify/482916?otp=48291637#token=hunter2") => readWithBrowserAuthority({ url: "https://bank.example/p", raw: true },
      { currentUrl: current, activeHtml: async () => "", authorize: () => true, admitUrl: async () => {}, fetch: (async () => new Response(body, { status: 200, headers: { "content-type": type } })) as typeof fetch });
    const r = await f("application/octet-stream", `<script>window.x="hunter2"</script><!-- hunter2-correct-horse --><div hidden>hunter2</div><span style="display:none">hunter2</span><iframe srcdoc="&lt;p&gt;hunter2&lt;/p&gt;"></iframe><style>a{background:url(data:text/plain,hunter2)}</style>`);
    expect(JSON.stringify(r)).not.toContain("hunter2");
    const clean = await read("<p>ok</p>");
    expect(clean.structuredContent.content).toBe("<p>ok</p>");
    const url = await readWithBrowserAuthority({ raw: true }, { currentUrl: "https://bank.example/verify/482916?otp=48291637#token=hunter2", activeHtml: async () => "<p>ok</p>", authorize: () => true, admitUrl: async () => {} });
    expect(JSON.stringify(url)).not.toMatch(/482916|48291637|hunter2/);
    await expect(f("application/x-48291637", "x").then(() => readWithBrowserAuthority({ url: "https://bank.example/p", requireMd: true },
      { currentUrl: "https://bank.example/", activeHtml: async () => "", authorize: () => true, admitUrl: async () => {}, fetch: (async () => new Response("x", { status: 200, headers: { "content-type": "application/x-48291637" } })) as typeof fetch }))).rejects.toThrow(/^(?!.*48291637)/);
  });
  it("leaves a clean page byte for byte", () => {
    const html = "<h1>Active page</h1><p>Current document</p>";
    expect(sanitizeRawHtml(html)).toBe(html);
  });
});

describe("native diagnostics", () => {
  it("writes no canary", async () => {
    const config = await import("./config.ts");
    config.ensureDirs();
    const native = await import("./drivers/native.ts");
    native.appendNative("thread-out-canary", { dir: "in", source: "test", msg: { tool_result: PAGE_TEXT, nested: { rows: [PAGE_TEXT] } } });
    const text = readFileSync(join(config.NATIVE_DIR, "thread-out-canary.ndjson"), "utf8");
    expect(text).toContain("tool_result");
    expect(leaks(text)).toEqual([]);
  });
  it("the append path keeps the folder inside its budget and ages out an idle previous segment", async () => {
    const config = await import("./config.ts");
    config.ensureDirs();
    const native = await import("./drivers/native.ts");
    const dir = config.NATIVE_DIR, day = 86400_000, now = Date.now();
    const old = join(dir, "idle-b.previous.ndjson");
    writeFileSync(old, "x"); utimesSync(old, (now - 8 * day) / 1000, (now - 8 * day) / 1000);
    Object.assign(native.nativeBudget, { maxBytes: 20_000, sweepEveryMs: 0 });
    try {
      for (let t = 0; t < 12; t++) native.appendNative(`budget-${t}`, { dir: "in", source: "t", msg: { text: "y".repeat(5000) } });
      const files = readdirSync(dir).filter(name => name.endsWith(".ndjson"));
      const total = files.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
      expect(total).toBeLessThanOrEqual(20_000 + 6000);
      expect(files).not.toContain("idle-b.previous.ndjson");
      expect(files).toContain("budget-11.ndjson");
    } finally { Object.assign(native.nativeBudget, { maxBytes: native.NATIVE_BUDGET_BYTES, sweepEveryMs: 60_000 }); }
  });
  it("enforceNativeBudget removes old traces, then the oldest until the folder fits, and keeps the live trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "out-budget-"));
    const { enforceNativeBudget, NATIVE_BUDGET_BYTES, NATIVE_MAX_AGE_MS } = await import("./drivers/native.ts");
    expect(NATIVE_BUDGET_BYTES).toBe(256 * 1024 * 1024);
    expect(NATIVE_MAX_AGE_MS).toBe(7 * 24 * 3600 * 1000);
    const now = Date.now(), day = 86400_000;
    const put = (name: string, bytes: number, ageMs: number) => { const path = join(dir, name); writeFileSync(path, "x".repeat(bytes)); const t = (now - ageMs) / 1000; utimesSync(path, t, t); };
    put("old.ndjson", 10, 8 * day);
    put("a.ndjson", 100, 3 * day); put("b.ndjson", 100, 2 * day); put("c.ndjson", 100, 1 * day); put("live.ndjson", 100, 5 * day);
    put("notes.txt", 100, 30 * day);
    const removed = enforceNativeBudget(dir, { maxBytes: 250, now, keep: ["live.ndjson"] });
    expect(removed).toBe(3); // old (age), a and b (oldest until 200 + live fits is not enough, so b goes too)
    expect(readdirSync(dir).sort()).toEqual(["c.ndjson", "live.ndjson", "notes.txt"]);
  });
});
