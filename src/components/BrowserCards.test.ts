// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Murage for Chrome cards (spec 9.3, 9.4): what the owner reads and which
// buttons each kind carries. The server card payload gains a `browser` object
// (T22/T25); a card without it renders exactly as before.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { ApprovalCard, type BrowserCardData, type BrowserCardKind } from "./ApprovalCard";
import { BrowserYourTurnCard } from "./BrowserYourTurnCard";
import { setLocale } from "@/lib/i18n";
import { en } from "@/locales";
import { allLocalePacks } from "@/locales/testing";
import type { Message } from "@/state/store";

afterEach(() => setLocale("en"));

const NEW_KEYS = ["browserExt.intent.matches", "browserExt.intent.mismatch", "browserExt.yourTurn.generic",
  "browserExt.l3.newRecipient.title", "browserExt.l3.newRecipient.body", "browserExt.l3.newRecipient.confirm", "browserExt.footer.everyTime", "browserExt.yourTurn.account",
  "browserExt.checker.fallbackBot", "browserExt.checker.reasonNoBotEngine", "browserExt.task.startNew", "browserExt.mode.full.name", "browserExt.actionCheck.flux"] as const;

function card(browser: Partial<BrowserCardData> & { kind: BrowserCardKind }, extra: Record<string, unknown> = {}): Message {
  return { id: "m", role: "bot", kind: "options", at: 1,
    card: { title: "Approval", subtitle: "raw subtitle", options: ["Allow", "Deny"], tool: "browser_extension_action", requestId: "r1",
      browser: { site: "mail.example.com", bot: "Dax", lines: [], ...browser }, ...extra } } as unknown as Message;
}
const render = (message: Message, onAnswer?: (choice: string) => void) =>
  renderToStaticMarkup(createElement(ApprovalCard, { message, ...(onAnswer ? { onAnswer } : {}) } as never));
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>([^<]*)</g)].map(m => m[1]).filter(label => label && !/Show/.test(label));

const KINDS: Array<[BrowserCardKind, string, string[]]> = [
  ["site", "Dax wants to use mail.example.com", ["Allow for this task", "Not now", "Never for Dax"]],
  ["siteAsk", "Dax wants to use mail.example.com", ["Allow for this task", "Not now"]],
  ["l2", "Dax wants to click and type on mail.example.com", ["Allow for this task", "Not now"]],
  ["send", "Send this message?", ["Send", "Deny"]],
  ["submit", "Submit this form?", ["Submit", "Deny"]],
  ["newRecipient", "Send to a new recipient?", ["Send", "Deny"]],
  ["post", "Post this?", ["Post", "Deny"]],
  ["delete", "Delete this?", ["Delete", "Deny"]],
  ["order", "Continue with this order?", ["Continue", "Deny"]],
  ["download", "Download report.pdf?", ["Download", "Deny"]],
  ["upload", "Upload a file to mail.example.com?", ["Choose file", "Deny"]],
  ["dialog", "Answer this page&#x27;s question?", ["OK", "Cancel", "Deny"]],
  ["leave", "Leave this page?", ["Leave", "Stay"]],
  ["link", "Open this link?", ["Open", "Deny"]],
];

describe("browser approval cards by kind", () => {
  it.each(KINDS)("%s shows its title and exactly its buttons", (kind, title, labels) => {
    const markup = render(card({ kind, details: { file: "report.pdf" } }), () => {});
    expect(markup).toContain(title);
    expect(buttons(markup)).toEqual(labels);
  });

  it("never offers Allow always on any kind, in any language", async () => {
    for (const [kind] of KINDS) {
      const markup = render(card({ kind }), () => {});
      expect(markup).not.toMatch(/always/i);
    }
    // the one "always" string the pack has is a settings control; no card, in any language, may show it
    const packs = await allLocalePacks();
    for (const [code, pack] of Object.entries(packs)) {
      const always = (pack as Record<string, string>)["browserExt.site.always"] ?? (en as Record<string, string>)["browserExt.site.always"];
      setLocale(code);
      for (const [kind] of KINDS) expect(render(card({ kind }), () => {}), `${code} ${kind}`).not.toContain(always);
    }
  });

  it("delete and a new recipient say Murage asks every time; no other kind does", () => {
    for (const [kind] of KINDS) {
      const markup = render(card({ kind }), () => {});
      if (kind === "delete" || kind === "newRecipient") expect(markup, kind).toContain("Murage asks every time for this, in every mode.");
      else expect(markup, kind).not.toContain("asks every time");
    }
  });

  it("the new recipient card names the recipient as text, never HTML", () => {
    const markup = render(card({ kind: "newRecipient", details: { recipients: '<b onclick="x">eve@example.com</b>' } }), () => {});
    expect(markup).toContain("&lt;b");
    expect(markup).not.toContain("<b onclick");
    expect(markup).toContain("They are not in your request.");
  });

  it("buttons answer through onAnswer with a stable choice, and never act without a handler", () => {
    const seen: string[] = [];
    const markup = render(card({ kind: "site" }), choice => seen.push(choice));
    expect(markup).toContain('data-choice="allow"');
    expect(markup).toContain('data-choice="deny"');
    expect(markup).toContain('data-choice="never"');
    expect(seen).toEqual([]);
    const idle = render(card({ kind: "send" }));
    expect(idle).not.toContain("<button");
  });

  it("puts the trusted classification and purpose first, page text after, collapsed", () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const markup = render(card({ kind: "send", details: { recipients: "ana@example.com" }, pageBlock: long }), () => {});
    expect(markup.indexOf("Dax wants to send a message on mail.example.com to ana@example.com.")).toBeGreaterThan(-1);
    expect(markup.indexOf("Dax wants to send")).toBeLessThan(markup.indexOf("From the page:"));
    expect(markup.indexOf("From the page:")).toBeLessThan(markup.indexOf("line 0"));
    expect(markup).toContain('data-approval-held="collapsed"');
  });

  it("renders page text as text, never as HTML", () => {
    const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const markup = render(card({ kind: "send", pageBlock: attack, details: { recipients: attack, form: attack, thing: attack, file: attack } }), () => {});
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
    expect(markup).toContain("&lt;img");
    const dialog = render(card({ kind: "dialog", pageBlock: attack }), () => {});
    expect(dialog).not.toContain("<img");
    expect(dialog).toContain("mail.example.com asks:");
  });

  it("shows intent lines, the checker verdict, the first step, and the right footer", () => {
    const markup = render(card({ kind: "send", lines: [
      { code: "I1" }, { code: "I2", recipient: "bob@example.com" }, { code: "I3" }, { code: "I5", siteA: "a.example", siteB: "b.example" }, { code: "mismatch" },
    ] }), () => {});
    for (const text of ["This site was not part of your request.", "New recipient not in your request: bob@example.com.", "This page has text that looks like instructions to Murage.",
      "This sends text from a.example to b.example.", "This may not match your request.", "Allow applies to this step only.", "Waiting for you. Dax will not act until you answer."]) expect(markup).toContain(text);
    const l2 = render(card({ kind: "l2", lines: [{ code: "firstStep", action: "open the inbox" }, { code: "matches" }] }), () => {});
    expect(l2).toContain("First step: open the inbox");
    expect(l2).toContain("This matches your request.");
    expect(l2).toContain("You can see and revoke this in Murage for Chrome.");
    expect(l2).not.toContain("Allow applies to this step only.");
  });

  it("settled and expired cards drop the buttons and say what happened", () => {
    const expired = render(card({ kind: "send" }, { answered: "unavailable" }), () => {});
    expect(expired).toContain("This request expired. Nothing was done.");
    expect(expired).not.toContain("<button");
    const allowed = render(card({ kind: "send" }, { answered: "allow" }), () => {});
    expect(allowed).toContain("Dax will continue the task now.");
    expect(allowed).not.toContain("<button");
    expect(render(card({ kind: "send", state: "expired" }), () => {})).toContain("This request expired. Nothing was done.");
  });

  it("a card without the browser object renders today's generic payload", () => {
    const message: Message = { id: "g", role: "bot", kind: "options", at: 1, card: { title: "Approval", subtitle: "Synthetic web search", options: ["Allow", "Deny"], tool: "WebSearch" } };
    const markup = render(message);
    expect(markup).toContain("Synthetic web search");
    expect(markup).toContain("Waiting for your answer below");
    expect(markup).not.toContain("<button");
  });

  it("ships the new copy in all eight languages without dashes or banned words", async () => {
    const packs = await allLocalePacks();
    expect(Object.keys(packs).filter(code => code !== "pt").sort()).toEqual(["de", "en", "es", "fr", "hi", "ja", "pt-br", "zh"]);
    for (const pack of Object.values(packs)) {
      for (const key of NEW_KEYS) {
        const value = (pack as Record<string, string>)[key];
        expect(value, key).toBeTruthy();
        expect(value).not.toContain("—");
        expect(value).not.toMatch(/\bsafe|safely|safety|unsafe|composio|price|always-on/i);
      }
    }
  });
});

describe("BrowserYourTurnCard", () => {
  const base = { bot: "Dax", site: "shop.example", pausedReason: "handoff" as const, actions: ["continue", "stop"] };
  const render2 = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(BrowserYourTurnCard, { ...base, ...props } as never));

  it.each([
    ["consent", "Dax stopped at a step only you can do: agreeing to shop.example&#x27;s terms, policies or cookies."],
    ["verification", "shop.example wants to check that a person is there."],
    ["credentials", "shop.example needs your password, a code or personal details."],
    ["payment", "Dax reached the last step of the order on shop.example."],
    ["account", "Dax stopped at an account or security change on shop.example"],
  ] as const)("%s body", (category, text) => {
    const markup = render2({ category, onContinue: () => {}, onStop: () => {} });
    expect(markup).toContain("Your turn");
    expect(markup).toContain(text);
    expect(buttons(markup)).toEqual(["Continue", "Stop task"]);
  });

  it("an unclassified step gets the generic body", () => {
    expect(render2({ category: null, onContinue: () => {} })).toContain("Dax stopped at a step that needs you on shop.example.");
  });

  it("hides Continue on the phone and says where to continue", () => {
    const markup = render2({ category: "verification", phone: true, onContinue: () => {}, onStop: () => {} });
    expect(buttons(markup)).not.toContain("Continue");
    expect(markup).toContain("Your turn on shop.example. Continue on your computer.");
  });

  it("never fakes an action: a button shows only when the status lists it and a handler exists", () => {
    expect(buttons(render2({ category: "consent", actions: [], onContinue: () => {}, onStop: () => {} }))).toEqual([]);
    expect(buttons(render2({ category: "consent", actions: ["stop"], onContinue: () => {}, onStop: () => {} }))).toEqual(["Stop task"]);
    expect(buttons(render2({ category: "consent", actions: ["continue", "stop"] }))).toEqual([]);
    expect(buttons(render2({ category: "consent", actions: undefined, onContinue: () => {} }))).toEqual([]);
  });

  it("renders nothing for a pause that is not a handoff, and no HTML from the site", () => {
    expect(render2({ category: "consent", pausedReason: "owner" })).toBe("");
    const markup = render2({ category: "verification", site: "<img src=x onerror=1>" });
    expect(markup).not.toContain("<img");
    expect(markup).not.toMatch(/always/i);
  });
});
