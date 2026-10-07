// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import * as intent from "./browser-intent.js";
import { checkIntent, type IntentInput, type Visibility } from "./browser-intent.js";

const readEntriesOf = (text: string): ReadonlySet<string> => intent.readEntriesOf(text);

const SITE = "https://shop.example";
const OTHER = "https://evil.test";
const visible: Visibility = { box: { x: 10, y: 10, width: 80, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null };

function input(over: Omit<Partial<IntentInput>, "action"> & { action?: Partial<IntentInput["action"]> } = {}): IntentInput {
  const { action, ...rest } = over;
  return {
    ownerWords: ["Buy the blue mug on shop.example"],
    taskSites: new Set([SITE]),
    readOrigins: new Map(),
    probeFlagged: false,
    visibility: visible,
    counters: { hits: 0 },
    mode: "task",
    action: { operation: "click", level: "L2", origin: SITE, hasTarget: true, ...action },
    ...rest,
  };
}

describe("checkIntent: clean paths", () => {
  it("passes an ordinary L2 click on a task site", () => {
    expect(checkIntent(input())).toEqual({ result: "pass" });
  });
  it("never passes a floor action", () => {
    expect(checkIntent(input({ action: { level: "floor" } })).result).not.toBe("pass");
  });
});

describe("I1 task scope", () => {
  it("cards a site that is not in the task set", () => {
    expect(checkIntent(input({ action: { origin: OTHER } }))).toEqual({ result: "card", rule: "I1", line: "This site was not part of your request." });
  });
  it("cards a navigation to an off-task origin even at L1", () => {
    const r = checkIntent(input({ action: { operation: "navigate", level: "L1", destination: `${OTHER}/`, hasTarget: false }, visibility: undefined }));
    expect(r).toMatchObject({ result: "card", rule: "I1" });
  });
  it("does not apply in step mode (every step already cards)", () => {
    expect(checkIntent(input({ mode: "step", action: { origin: OTHER } })).result).toBe("pass");
  });
  it("passes an origin reached from a task page (in the set)", () => {
    expect(checkIntent(input({ taskSites: new Set([SITE, OTHER]), action: { origin: OTHER } }))).toEqual({ result: "pass" });
  });
});

describe("I2 new recipient", () => {
  const send = (recipients: string[], extra: Omit<Partial<IntentInput>, "action"> = {}) => input({ action: { operation: "click", level: "L3", recipients }, ...extra });
  it("cards a recipient that the owner never named", () => {
    expect(checkIntent(send(["x@evil.test"]))).toEqual({ result: "card", rule: "I2", line: "New recipient not in your request: x@evil.test." });
  });
  it("passes when the owner words name the recipient", () => {
    expect(checkIntent(send(["priya@work.example"], { ownerWords: ["Email priya@work.example the notes"], taskSites: new Set([SITE]) }))).toEqual({ result: "pass" });
  });
  it("passes a recipient already in the replied thread", () => {
    expect(checkIntent(send(["Priya@Work.example"], { threadRecipients: ["priya@work.example"] }))).toEqual({ result: "pass" });
  });
  it("does not accept a suffix of an owner-named address", () => {
    const r = checkIntent(send(["x@evil.test"], { ownerWords: ["mail boss-x@evil.test"] }));
    expect(r).toMatchObject({ result: "card", rule: "I2" });
  });
  it("matches phone numbers by digits", () => {
    expect(checkIntent(send(["+1 (555) 010-9999"], { ownerWords: ["text 555 010 9999"] }))).toEqual({ result: "pass" });
    expect(checkIntent(send(["+1 555 010 1111"], { ownerWords: ["text 555 010 9999"] }))).toMatchObject({ rule: "I2" });
  });
  it("matches @handles", () => {
    expect(checkIntent(send(["@priya"], { ownerWords: ["DM @priya"] }))).toEqual({ result: "pass" });
    expect(checkIntent(send(["@mallory"], { ownerWords: ["DM @priya"] }))).toMatchObject({ rule: "I2" });
  });
  it("F4 evasion: zero-width inside the recipient is not the address the owner named", () => {
    const r = checkIntent(send(["priya@work​.example"], { ownerWords: ["Email priya@work.example"] }));
    expect(r).toMatchObject({ result: "card", rule: "I2" });
  });
  it("F4 evasion: fullwidth look-alike recipient is not the owner-named address", () => {
    const r = checkIntent(send(["ｐriya@work.example"], { ownerWords: ["Email priya@work.example"] }));
    expect(r).toMatchObject({ result: "card", rule: "I2" });
  });
  it("F4: zero-width in the owner words does not hide a named recipient", () => {
    expect(checkIntent(send(["priya@work.example"], { ownerWords: ["Email priya@wo​rk.example"] }))).toEqual({ result: "pass" });
  });
  it("applies by send capability rather than level", () => {
    expect(checkIntent(input({ action: { level: "L2", recipients: ["x@evil.test"] } })).result).toBe("card");
  });
});

describe("I3 from the probe flag", () => {
  it("cards when the probe flagged the page", () => {
    expect(checkIntent(input({ probeFlagged: true }))).toEqual({ result: "card", rule: "I3", line: "This page has text that looks like instructions to Murage." });
  });
  it("does not card a free L1 read", () => {
    expect(checkIntent(input({ probeFlagged: true, action: { operation: "read", level: "L1", hasTarget: false }, visibility: undefined })).result).toBe("pass");
  });
});

describe("I4 hidden target", () => {
  const refuseLine = "The bot tried to use a hidden control. Nothing was done.";
  const cases: Array<[string, Visibility | undefined]> = [
    ["no box", { ...visible, box: null }],
    ["zero-size box", { ...visible, box: { x: 0, y: 0, width: 0, height: 20 } }],
    ["opacity under 0.1", { ...visible, opacity: 0.05 }],
    ["visibility hidden", { ...visible, visibility: "hidden" }],
    ["aria-hidden with no visible box", { ...visible, ariaHidden: true, box: null }],
    ["off-screen after scroll", { ...visible, inViewport: false }],
    ["covered", { ...visible, coveredBy: "div#cookie-overlay" }],
    ["target operation without visibility facts", undefined],
  ];
  for (const [name, v] of cases) {
    it(`refuses ${name}`, () => {
      expect(checkIntent(input({ visibility: v }))).toEqual({ result: "refuse", rule: "I4", line: refuseLine });
    });
  }
  it("refuses at every level", () => {
    for (const level of ["L1", "L2", "L3"] as const) expect(checkIntent(input({ visibility: { ...visible, opacity: 0 }, action: { level } }))).toMatchObject({ result: "refuse", rule: "I4" });
  });
  it("opacity exactly 0.1 is visible; aria-hidden with a visible box is visible", () => {
    expect(checkIntent(input({ visibility: { ...visible, opacity: 0.1 } })).result).toBe("pass");
    expect(checkIntent(input({ visibility: { ...visible, ariaHidden: true } })).result).toBe("pass");
  });
  it("a refusal is never softened to a card by another rule", () => {
    const r = checkIntent(input({ probeFlagged: true, visibility: { ...visible, opacity: 0 }, action: { origin: OTHER } }));
    expect(r).toMatchObject({ result: "refuse", rule: "I4" });
  });
  it("a floor action that is also hidden stays a refusal", () => {
    expect(checkIntent(input({ visibility: { ...visible, box: null }, action: { level: "floor" } })).result).toBe("refuse");
  });
});

describe("I5 cross-site carry", () => {
  const span = "Order reference A1B2C3D4E5F6G7H8 for Dax Murage account";
  const read = (text: string, origin = OTHER) => new Map([[origin, readEntriesOf(text)]]);
  const type = (typedText: string, readOrigins: IntentInput["readOrigins"], extra: Omit<Partial<IntentInput>, "action"> = {}) =>
    input({ readOrigins, taskSites: new Set([SITE, OTHER]), action: { operation: "type", level: "L2", typedText }, ...extra });

  it("cards a 40-character span read on another origin, naming both sites", () => {
    const r = checkIntent(type(`Hi, ${span}, please help`, read(span)));
    expect(r).toEqual({ result: "card", rule: "I5", line: "This sends text from evil.test to shop.example." });
  });
  it("does not card a span read on the same origin", () => {
    expect(checkIntent(type(span, read(span, SITE))).result).toBe("pass");
  });
  it("does not card short overlap", () => {
    expect(checkIntent(type("Order reference A1B2C3", read(span))).result).toBe("pass");
  });
  it("F4 evasion: zero-width characters and case changes do not hide the span", () => {
    const evaded = span.split("").join("​").toUpperCase();
    expect(checkIntent(type(evaded, read(span)))).toMatchObject({ result: "card", rule: "I5" });
  });
  it("F4 evasion: fullwidth look-alikes (NFKC) do not hide the span", () => {
    const wide = span.replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    expect(checkIntent(type(wide, read(span)))).toMatchObject({ result: "card", rule: "I5" });
  });
  it("F4 evasion: extra whitespace does not hide the span", () => {
    expect(checkIntent(type(span.replace(/ /g, "   \n "), read(span)))).toMatchObject({ rule: "I5" });
  });
  it("cards a secret-looking token read elsewhere (long digit run, with separators)", () => {
    const readOrigins = read("card 4111111111111111 on file");
    expect(checkIntent(type("my number is 4111 1111 1111 1111", readOrigins))).toMatchObject({ result: "card", rule: "I5" });
  });
  it("cards key-prefixed and base64 tokens read elsewhere", () => {
    for (const tok of ["sk-live-abcdef123456", "ghp_abcdefghijklmnop", ["AKIA", "ABCDEFGHIJKLMNOP"].join(""), "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5"]) {
      const readOrigins = read(`key ${tok} here`);
      expect(checkIntent(type(`token ${tok} end`, readOrigins)), tok).toMatchObject({ result: "card", rule: "I5" });
    }
  });
  it("does not card a secret-shaped token that was never read from another origin", () => {
    expect(checkIntent(type("code 4111111111111111", new Map())).result).toBe("pass");
  });
  it("does not card ordinary short words that match a digest-less read", () => {
    expect(checkIntent(type("hello world", read(span))).result).toBe("pass");
  });
  it("applies to submitted text in a form destination", () => {
    const r = checkIntent(input({ readOrigins: read(span), taskSites: new Set([SITE, OTHER]), action: { operation: "submit", level: "L3", typedText: span, destination: `${SITE}/support` } }));
    expect(r).toMatchObject({ rule: "I5" });
  });
  it("T5 two-site carry: owner asked to copy it, still a card", () => {
    const r = checkIntent(type("A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0", read("order A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0 shipped"), { ownerWords: ["Copy my order number into the support form"] }));
    expect(r).toMatchObject({ rule: "I5" });
  });
});

describe("I6 data in navigation (same cases as the policy discloses rule)", () => {
  const nav = (destination: string, extra: Partial<IntentInput["action"]> = {}) =>
    input({ taskSites: new Set([SITE, OTHER]), visibility: undefined, action: { operation: "navigate", level: "L1", origin: SITE, destination, currentUrl: `${SITE}/cart?x=1`, hasTarget: false, ...extra } });

  it("owner-requested first navigation is free (chromereal)", () => {
    expect(checkIntent(nav(`${SITE}/deep/path?q=1#f`, { ownerRequested: true }))).toEqual({ result: "pass" });
    expect(checkIntent(nav(`${OTHER}/deep/path?q=1`, { ownerRequested: true }))).toEqual({ result: "pass" });
  });
  it("other origin: a bare origin is free", () => {
    expect(checkIntent(nav(`${OTHER}/`))).toEqual({ result: "pass" });
    expect(checkIntent(nav(OTHER))).toEqual({ result: "pass" });
  });
  it("other origin: path, query or fragment is data", () => {
    for (const d of [`${OTHER}/a`, `${OTHER}/?q=secret`, `${OTHER}/#frag`]) expect(checkIntent(nav(d))).toMatchObject({ result: "card", rule: "I6" });
  });
  it("same origin: free until page data was read", () => {
    expect(checkIntent(nav(`${SITE}/other?q=1`))).toEqual({ result: "pass" });
  });
  it("same origin: different path or query is data once page data was read", () => {
    expect(checkIntent(nav(`${SITE}/other`, { pageDataRead: true }))).toMatchObject({ result: "card", rule: "I6" });
    expect(checkIntent(nav(`${SITE}/cart?x=2`, { pageDataRead: true }))).toMatchObject({ result: "card", rule: "I6" });
  });
  it("same origin: a link the page presents is free", () => {
    expect(checkIntent(nav(`${SITE}/other`, { pageDataRead: true, presentedLink: true }))).toEqual({ result: "pass" });
  });
  it("same origin: moving within the same document is free", () => {
    expect(checkIntent(nav(`${SITE}/cart?x=1#top`, { pageDataRead: true }))).toEqual({ result: "pass" });
  });
  it("read operations follow the same rule; any operation with a cross-origin destination is checked (policy discloses)", () => {
    expect(checkIntent(nav(`${OTHER}/a`, { operation: "read" }))).toMatchObject({ rule: "I6" });
    expect(checkIntent(input({ visibility: visible, action: { operation: "click", level: "L2", destination: `${OTHER}/a` } }))).toMatchObject({ result: "card", rule: "I6" });
  });
  it("B4: ownerRequested exempts only navigate and read, like the policy", () => {
    expect(checkIntent(input({ visibility: visible, action: { operation: "submit", level: "L3", destination: `${OTHER}/collect?d=1`, ownerRequested: true } }))).toMatchObject({ result: "card", rule: "I6" });
  });
  it("B4: same-origin checks stay navigate/read only", () => {
    expect(checkIntent(input({ visibility: visible, action: { operation: "click", level: "L2", destination: `${SITE}/other`, pageDataRead: true, currentUrl: `${SITE}/cart` } })).result).toBe("pass");
  });
  it("B10: a username or password in the destination URL is data", () => {
    expect(checkIntent(nav("https://user:pw@shop.example/cart?x=1", { pageDataRead: true }))).toMatchObject({ result: "card", rule: "I6" });
    expect(checkIntent(nav("https://alice@evil.test/"))).toMatchObject({ result: "card", rule: "I6" });
    expect(checkIntent(nav("https://alice:secret@evil.test/", { ownerRequested: false }))).toMatchObject({ result: "card", rule: "I6" });
  });
  it("an unparseable current URL counts as data", () => {
    expect(checkIntent(nav(`${SITE}/other`, { pageDataRead: true, currentUrl: "not a url" }))).toMatchObject({ rule: "I6" });
  });
  it("an unparseable destination is data, never a throw", () => {
    expect(checkIntent(nav("http://[bad", {}))).toMatchObject({ result: "card" });
  });
});

describe("I7 repeats", () => {
  const pause = "Murage paused this task. The page kept asking for things you did not ask for.";
  it("the third unknown-recipient send pauses it", () => {
    expect(checkIntent(input({ counters: { hits: 2 }, action: { origin: OTHER, recipientScanFailed: true, sendCapable: true } }))).toEqual({ result: "refuse", rule: "I7", line: pause });
  });
  it("two earlier hits and a clean action still pass", () => {
    expect(checkIntent(input({ counters: { hits: 2 } }))).toEqual({ result: "pass" });
  });
  it("an unknown send at the threshold is refused", () => {
    expect(checkIntent(input({ counters: { hits: 3 }, action: { recipientScanFailed: true, sendCapable: true } }))).toMatchObject({ result: "refuse", rule: "I7", line: pause });
  });
  it("one hit and one more card stays a card", () => {
    expect(checkIntent(input({ counters: { hits: 1 }, action: { origin: OTHER } })).result).toBe("card");
  });
  it("a hidden target refusal does not become an I7 hit", () => {
    expect(checkIntent(input({ counters: { hits: 2 }, visibility: { ...visible, opacity: 0 } }))).toMatchObject({ result: "refuse", rule: "I4" });
  });
});

describe("floor and ordering", () => {
  it("a floor action with no rule firing is a card, never a pass", () => {
    expect(checkIntent(input({ action: { level: "floor" } })).result).toBe("card");
  });
  it("B2: every card rule that fires adds its line; rule is the first (I1 before I2 before I3 before I5 before I6)", () => {
    const r = checkIntent(input({ probeFlagged: true, action: { origin: OTHER, level: "L3", recipients: ["x@evil.test"] } }));
    expect(r).toEqual({ result: "card", rule: "I1", line: ["This site was not part of your request.", "New recipient not in your request: x@evil.test.", "This page has text that looks like instructions to Murage."].join("\n") });
  });
  it("B2: I2 still shows when I1 fires; several card rules count as one hit for I7", () => {
    const r = checkIntent(input({ counters: { hits: 1 }, probeFlagged: true, action: { origin: OTHER, level: "L3", recipients: ["x@evil.test"] } }));
    expect(r.result).toBe("card");
    expect(r.line).toContain("x@evil.test");
  });
  it("B2: I5 and I6 lines both show", () => {
    const span = "Order reference A1B2C3D4E5F6G7H8 for Dax Murage account";
    const r = checkIntent(input({ readOrigins: new Map([["https://third.example", readEntriesOf(span)]]), taskSites: new Set([SITE, OTHER]), action: { operation: "submit", level: "L3", typedText: span, destination: `${OTHER}/collect` } }));
    expect(r).toEqual({ result: "card", rule: "I5", line: "This sends text from third.example to evil.test.\nThis link to evil.test carries information from your task." });
  });
});

describe("Opus gate fixes", () => {
  it("B1: a click with no hasTarget and no visibility facts is refused (target derived from the operation)", () => {
    for (const operation of ["click", "fill", "type", "select_option", "hover", "drag", "press", "check", "uncheck", "submit", "upload"]) {
      expect(checkIntent(input({ visibility: undefined, action: { operation, hasTarget: undefined } })), operation).toMatchObject({ result: "refuse", rule: "I4" });
    }
  });
  it("B1: navigate and read need no target; an explicit hasTarget false is honoured", () => {
    expect(checkIntent(input({ visibility: undefined, action: { operation: "navigate", destination: `${SITE}/`, hasTarget: undefined } })).result).toBe("pass");
    expect(checkIntent(input({ visibility: undefined, action: { operation: "read", level: "L1", hasTarget: undefined } })).result).toBe("pass");
    expect(checkIntent(input({ visibility: undefined, action: { operation: "snapshot", hasTarget: false } })).result).toBe("pass");
  });

  it("B3: a zero-width recipient line shows the hidden character and is not the owner's address", () => {
    const r = checkIntent(input({ ownerWords: ["Email priya@work.example"], action: { level: "L3", recipients: ["priya@work\u200B.example"] } }));
    expect(r.rule).toBe("I2");
    expect(r.line).not.toBe("New recipient not in your request: priya@work.example.");
    expect(r.line).toContain("priya@work\\u{200B}.example");
    expect(r.line).toContain("It contains hidden or look-alike characters.");
  });
  it("B3: a fullwidth look-alike is escaped too; a plain new recipient has no note", () => {
    const r = checkIntent(input({ ownerWords: ["Email priya@work.example"], action: { level: "L3", recipients: ["\uFF50riya@work.example"] } }));
    expect(r.line).toContain("\\u{FF50}riya@work.example");
    expect(r.line).toContain("look-alike");
    expect(checkIntent(input({ action: { level: "L3", recipients: ["x@evil.test"] } })).line).toBe("New recipient not in your request: x@evil.test.");
  });
  it("B3: a very long recipient is capped", () => {
    const r = checkIntent(input({ action: { level: "L3", recipients: ["a".repeat(500) + "@evil.test"] } }));
    expect(r.rule).toBe("I2");
    expect(r.line!.length).toBeLessThan(200);
  });
  it("B3: every new recipient is named, not only the first", () => {
    const r = checkIntent(input({ ownerWords: ["Email priya@work.example"], action: { level: "L3", recipients: ["priya@work.example", "a@evil.test", "b@evil.test"] } }));
    expect(r.line).toContain("a@evil.test");
    expect(r.line).toContain("b@evil.test");
    expect(r.line).not.toContain("priya");
  });

  describe("B5 I5 bypasses", () => {
    const type = (typedText: string, readOrigins: IntentInput["readOrigins"], extra: Omit<Partial<IntentInput>, "action"> = {}) =>
      input({ readOrigins, taskSites: new Set([SITE, OTHER]), action: { operation: "type", level: "L2", typedText }, ...extra });
    const read = (text: string) => new Map([[OTHER, readEntriesOf(text)]]);
    it("a 6-digit code read on another origin", () => {
      expect(checkIntent(type("482913", read("Your code 482913 expires soon")))).toMatchObject({ result: "card", rule: "I5", line: "This sends text from evil.test to shop.example." });
    });
    it("a 6-digit code glued to another number on the page", () => {
      expect(checkIntent(type("482913", read("code 482913 7 days")))).toMatchObject({ rule: "I5" });
    });
    it("a dotted card number", () => {
      expect(checkIntent(type("4111.1111.1111.1111", read("card 4111 1111 1111 1111 on file")))).toMatchObject({ rule: "I5" });
      expect(checkIntent(type("my card 4111 1111 1111 1111", read("card 4111.1111.1111.1111 on file")))).toMatchObject({ rule: "I5" });
    });
    it("spaced and punctuated typing of a key", () => {
      expect(checkIntent(type("s k - l i v e - a b c d e f 1 2 3 4 5 6", read("key sk-live-abcdef123456 here")))).toMatchObject({ rule: "I5" });
    });
    it("spaced typing of a 40-character span", () => {
      const span = "Order reference A1B2C3D4E5F6G7H8 for Dax Murage account";
      expect(checkIntent(type(span.split("").join(" . "), read(span)))).toMatchObject({ rule: "I5" });
    });
    it("a token split across two fills to the same destination", () => {
      const r = read("key sk-live-abcdefghij12 here");
      expect(checkIntent(type("sk-live-abc", r)).result).toBe("pass");
      const history = new Map([[SITE, intent.nextTypedHistory(undefined, "sk-live-abc")]]);
      expect(checkIntent(type("defghij12", r, { typedHistory: history }))).toMatchObject({ rule: "I5" });
    });
    it("text typed earlier is not re-carded on its own once it is history", () => {
      const r = read("Your code 482913 expires soon");
      const history = new Map([[SITE, intent.nextTypedHistory(undefined, "482913")]]);
      expect(checkIntent(type(" thanks", r, { typedHistory: history })).result).toBe("pass");
    });
    it("history kept for another destination does not join", () => {
      const r = read("key sk-live-abcdefghij12 here");
      const history = new Map([["https://third.example", intent.nextTypedHistory(undefined, "sk-live-abc")]]);
      expect(checkIntent(type("defghij12", r, { typedHistory: history })).result).toBe("pass");
    });
    it("a short ordinary number is not a token", () => {
      expect(checkIntent(type("12345", read("Call 12345 now")))).toEqual({ result: "pass" });
    });
  });

  it("B6b: a page inside the entry ceiling still passes an unrelated long fill, fast", () => {
    let big = ""; let i = 0;
    while (big.length < 90_000) { big += `w${i} lorem ${(i * 7) % 10} `; i++; }
    const readOrigins = new Map([[OTHER, readEntriesOf(big)]]);
    const action = input({ readOrigins, taskSites: new Set([SITE, OTHER]), action: { operation: "type", level: "L2", typedText: "Hello, please find my note below. ".repeat(60) } });
    checkIntent(action);
    const t0 = performance.now();
    expect(checkIntent(action).result).toBe("pass");
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it("B6: one check against a 400k-character origin stays fast and, past the entry ceiling, asks rather than passes (C3)", () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    let big = ""; let i = 0;
    while (big.length < 400_000) { big += `${words[i % 10]} ${i} lorem ipsum ${words[(i * 7) % 10]} `; i++; }
    const readOrigins = new Map([[OTHER, readEntriesOf(big)]]);
    const typed = "Hello, please find my note below. ".repeat(60);
    const action = input({ readOrigins, taskSites: new Set([SITE, OTHER]), action: { operation: "type", level: "L2", typedText: typed } });
    checkIntent(action);
    const t0 = performance.now();
    const r = checkIntent(action);
    const ms = performance.now() - t0;
    expect(r.result).toBe("card");
    expect(ms).toBeLessThan(200);
  });

  it("B7: probe cards retain I3 and do not count as unknown sends", () => {
    expect(checkIntent(input({ probeFlagged: true })).rule).toBe("I3");
    expect(checkIntent(input({ probeFlagged: true, counters: { hits: 2 } }))).toMatchObject({ result: "card", rule: "I3" });
  });

  it("B8: a short owner number does not match a longer recipient number by suffix", () => {
    expect(checkIntent(input({ ownerWords: ["text 555-1234"], action: { level: "L3", recipients: ["+19005551234"] } }))).toMatchObject({ result: "card", rule: "I2" });
    expect(checkIntent(input({ ownerWords: ["text +1 555 010 9999"], action: { level: "L3", recipients: ["555 010 9999"] } })).result).toBe("pass");
    expect(checkIntent(input({ ownerWords: ["text 555-1234"], action: { level: "L3", recipients: ["555 1234"] } })).result).toBe("pass");
  });
  it("B8: a bare name does not match an owner address that continues with @", () => {
    expect(checkIntent(input({ ownerWords: ["Email bob@corp.com"], action: { level: "L3", recipients: ["bob"] } }))).toMatchObject({ result: "card", rule: "I2" });
    expect(checkIntent(input({ ownerWords: ["DM @bob@corp.social"], action: { level: "L3", recipients: ["@bob"] } }))).toMatchObject({ result: "card", rule: "I2" });
    expect(checkIntent(input({ ownerWords: ["Invite bob to the doc"], action: { level: "L3", recipients: ["bob"] } })).result).toBe("pass");
  });

  it("B9: missing or invalid visibility numbers count as hidden", () => {
    const bad: Array<Partial<Visibility>> = [
      { opacity: Number.NaN }, { opacity: undefined as never }, { inViewport: undefined as never },
      { box: { x: 0, y: 0, width: Number.NaN, height: 20 } }, { box: { x: 0, y: 0, width: 20, height: undefined as never } },
      { visibility: undefined as never },
    ];
    for (const b of bad) expect(checkIntent(input({ visibility: { ...visible, ...b } })), JSON.stringify(b)).toMatchObject({ result: "refuse", rule: "I4" });
  });
});

// Contract (Opus gate): T01's collector output is accepted as the intent check's visibility input.
import type { FloorVisibility } from "./browser-floor-facts.ts";
import type { Visibility as IntentVisibility } from "./browser-intent.ts";
const _contract: (v: FloorVisibility) => IntentVisibility = (v) => v;
void _contract;
describe("Opus gate: null visibility facts from the collector read as hidden", () => {
  it("every null field refuses I4", () => {
    const base = { box: { x: 0, y: 0, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null };
    for (const key of ["inViewport", "opacity", "visibility"] as const) {
      const r = checkIntent({ ownerWords: ["click the button"], taskSites: new Set(["https://a.example"]), readOrigins: new Map(), probeFlagged: false, action: { operation: "click", level: "L2", origin: "https://a.example" }, visibility: { ...base, [key]: null }, counters: { hits: 0 } } as never);
      expect(r.result, key).toBe("refuse");
    }
  });
});

describe("Opus gate round 2: page text cannot stall the token reader", () => {
  it("readEntriesOf on 400k of eyJ- runs in linear time", () => {
    const t0 = performance.now();
    intent.readEntriesOf("eyJ-".repeat(100000));
    expect(performance.now() - t0).toBeLessThan(1500);
  });
  it("ariaHidden null reads as hidden even with a box", () => {
    const vis = { box: { x: 0, y: 0, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: null, coveredBy: null };
    const r = checkIntent({ ownerWords: ["click the button"], taskSites: new Set(["https://a.example"]), readOrigins: new Map(), probeFlagged: false, action: { operation: "click", level: "L2", origin: "https://a.example" }, visibility: vis, counters: { hits: 0 } } as never);
    expect(r.result).toBe("refuse");
  });
});

// T22 (item 5): when the recipient scan cannot run on a send or submit, the recipients are unknown. Unknown is not silent.
describe("I2 fail direction: an unreadable recipient scan", () => {
  const failed = (over: Partial<IntentInput["action"]> = {}) => ({ level: "L3" as const, operation: "click", recipientScanFailed: true, ...over });
  it("attended: an L3 action whose scan failed is a card that says the recipients are unknown", () => {
    const result = checkIntent(input({ action: failed() }));
    expect(result).toMatchObject({ result: "card", rule: "I2" });
    expect(result.line).toContain("could not check who this goes to");
  });
  it("unattended (a routine): the same action is refused, never carded", () => {
    expect(checkIntent(input({ unattended: true, action: failed() }))).toMatchObject({ result: "refuse", rule: "I2" });
  });
  it("applies in every mode, including full", () => {
    for (const mode of ["step", "task", "full"] as const) expect(checkIntent(input({ mode, action: failed() }))).toMatchObject({ result: "card", rule: "I2" });
  });
  it("a scan that worked (flag absent) with nothing found passes, and one that found names still names them", () => {
    expect(checkIntent(input({ action: { level: "L3", operation: "click" } })).result).toBe("pass");
    expect(checkIntent(input({ action: { level: "L3", operation: "click", recipients: ["eve@evil.test"] } })).line).toContain("eve@evil.test");
  });
  it("action kind controls recipient checks even below L3", () => {
    expect(checkIntent(input({ action: failed({ level: "L2" }) })).result).toBe("card");
    expect(checkIntent(input({ action: failed({ level: "L1", operation: "read" }) })).result).toBe("pass");
  });
  it("a failed scan is counted as an I-rule hit like any other card", () => {
    expect(checkIntent(input({ counters: { hits: 2 }, action: failed() }))).toMatchObject({ result: "refuse", rule: "I7" });
  });
  it("the unattended refusal does not depend on the hit count", () => {
    expect(checkIntent(input({ unattended: true, counters: { hits: 0 }, action: failed() })).result).toBe("refuse");
  });
});


describe("MEM-001 provenance ceiling and saturation (C3)", () => {
  const page = (n: number) => Array.from({ length: 20_000 }, (_, i) => String.fromCharCode(97 + ((i * 7 + n * 13 + (i >> 5) * n) % 26)) + ((i * n) % 10)).join("");
  it("50 reads of 20,000 characters hold at most the entry ceiling (under 8 MiB of hashes)", () => {
    const set = new Set<string>();
    for (let n = 1; n <= 50; n++) intent.readEntriesOf(page(n), set);
    expect(set.size).toBeLessThanOrEqual(intent.MAX_READ_ENTRIES + 21_000);
    const bytes = [...set].reduce((a, h) => a + h.length * 2 + 40, 0);
    console.log(`C3 provenance entries=${set.size} approxBytes=${bytes}`);
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
    expect(set.has(intent.SATURATED)).toBe(true);
  });
  it("a saturated origin asks before a long cross-origin carry, and a short fill still passes", () => {
    const set = new Set<string>();
    for (let n = 1; n <= 50; n++) intent.readEntriesOf(page(n), set);
    const base = { readOrigins: new Map([[OTHER, set]]), taskSites: new Set([SITE, OTHER]) };
    const long = checkIntent(input({ ...base, action: { operation: "type", level: "L2", typedText: "a long reply that is certainly more than forty letters in total" } }));
    expect(long).toMatchObject({ result: "card", rule: "I5" });
    expect(checkIntent(input({ ...base, action: { operation: "type", level: "L2", typedText: "hello there" } }))).toEqual({ result: "pass" });
  });
  it("secret-looking tokens keep being remembered after saturation", () => {
    const set = new Set<string>();
    for (let n = 1; n <= 50; n++) intent.readEntriesOf(page(n), set);
    intent.readEntriesOf("your code is 482913", set);
    const r = checkIntent(input({ readOrigins: new Map([[OTHER, set]]), taskSites: new Set([SITE, OTHER]), action: { operation: "type", level: "L2", typedText: "482913" } }));
    expect(r).toMatchObject({ result: "card", rule: "I5" });
  });
  it("a spent token reserve still asks about a short secret typed to another origin (Astra xr-c3)", () => {
    const set = new Set<string>();
    for (let n = 1; n <= 5; n++) intent.readEntriesOf(page(n), set);
    intent.readEntriesOf(Array.from({ length: 25_000 }, (_, i) => `code ${100000 + i}`).join(" "), set);
    intent.readEntriesOf("your code is 999999", set);
    expect(set.has(intent.SATURATED_TOKENS)).toBe(true);
    const r = checkIntent(input({ readOrigins: new Map([[OTHER, set]]), taskSites: new Set([SITE, OTHER]), action: { operation: "type", level: "L2", typedText: "999999" } }));
    expect(r).toMatchObject({ result: "card", rule: "I5" });
    expect(checkIntent(input({ readOrigins: new Map([[OTHER, set]]), taskSites: new Set([SITE, OTHER]), action: { operation: "type", level: "L2", typedText: "hello there" } }))).toEqual({ result: "pass" });
  });
});
