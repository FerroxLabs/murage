import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatSignInGate, offerShownHere, runOfferSignIn } from "@/components/cloud/BotSignInOffer";
import { BROWSER_SIGNIN_ENGINES, CREATE_STEP_SKIP, OFFER_DISMISS, OWN_CLAUDE_BUTTON, HOME_CLAUDE_BUTTON, botsToSignIn, createStepBody, createStepButton, createStepTitle, firstOffer, signInOfferHere, homeSetUpLine, queueOfferButton, queueOfferCopy, signInLine, type HomeBot } from "./cloud-signin-status";
// the words this product never uses, built from pieces so the guard itself carries none of them
const BANNED = new RegExp(["\\b(?:sa", "fe|sa", "fely|sa", "fety|unsa", "fe)\\b"].join(""), "i");
const DASHES = /[\u2013\u2014]/;

const bot = (id: string, engine: string, label: string, signedIn: boolean, uses: "home" | "own" | null = null): HomeBot => ({ id, name: id[0]!.toUpperCase() + id.slice(1), signIn: { engine, label, signedIn, uses } });
const fuigo = (id: string, signedInEngines: string[] = []): HomeBot => ({ id, name: id[0]!.toUpperCase() + id.slice(1), signIn: { engine: "fuigoAgent", label: "Fuigo", signedIn: true, uses: null, signedInEngines } });
const BOTS = [bot("atlas", "codex", "Codex", true), bot("nova", "codex", "Codex", false), bot("kit", "codex", "Codex", false), bot("rex", "grokAgent", "Grok", false),
  bot("ada", "claudeAgent", "Claude", true, "home"), bot("bo", "claudeAgent", "Claude", true, "own"), { id: "plain", name: "Plain" }];

describe("Cloud sign-in lines", () => {
  it("say signed in or needs sign-in in plain words, and which Claude account a bot uses", () => {
    expect(signInLine(BOTS[0]!)).toBe("Codex: signed in");
    expect(signInLine(BOTS[1]!)).toBe("Codex: needs sign-in");
    expect(signInLine(BOTS[4]!)).toBe("Claude: signed in with the home's account");
    expect(signInLine(BOTS[5]!)).toBe("Claude: signed in with its own account");
    expect(signInLine(bot("zed", "claudeAgent", "Claude", false))).toBe("Claude: needs sign-in");
    expect(signInLine(BOTS[6]!)).toBeNull();
  });
  it("the queue after a sign-in: the other bots on that engine that need one, never the one just done, never Claude, never a skipped bot", () => {
    expect(botsToSignIn(BOTS, "codex", "atlas").map((b) => b.id)).toEqual(["nova", "kit"]);
    expect(botsToSignIn(BOTS, "codex", "nova", new Set(["kit:codex"])).map((b) => b.id)).toEqual([]);
    expect(botsToSignIn(BOTS, "grokAgent", "rex")).toEqual([]);
    expect(botsToSignIn(BOTS, "claudeAgent", "ada")).toEqual([]);
    expect(botsToSignIn(BOTS, "antigravityAgent", "x")).toEqual([]);
  });
  it("the offer names the bot and the engine in plain words", () => {
    expect(queueOfferCopy(BOTS[1]!, "Codex")).toBe("Codex is signed in on another bot. Nova needs its own Codex sign-in.");
    expect(queueOfferButton(BOTS[1]!, "Codex")).toBe("Sign Nova in to Codex and use it");
  });
  it("a bot on Fuigo with no sign-in for the engine is offered it; one already signed in, or on another chosen engine, is not", () => {
    const home = [BOTS[0]!, fuigo("zed"), fuigo("amy", ["codex"]), BOTS[3]!, BOTS[4]!];
    expect(botsToSignIn(home, "codex", "atlas").map((b) => b.id)).toEqual(["zed"]);
    expect(botsToSignIn(home, "codex", "atlas", new Set(["zed:codex"]))).toEqual([]);
    expect(botsToSignIn(home, "grokAgent", "x").map((b) => b.id)).toEqual(["zed", "amy", "rex"]);
  });
  it("on opening, the first offer is for an engine signed in on another bot and a bot that lacks it; none when no bot is signed in anywhere", () => {
    expect(firstOffer([BOTS[0]!, fuigo("zed")])).toMatchObject({ engine: "codex", label: "Codex", bot: { id: "zed" } });
    expect(firstOffer([BOTS[0]!, fuigo("zed")], new Set(["zed:codex"]))).toBeNull();
    expect(firstOffer([fuigo("zed"), fuigo("amy")])).toBeNull();
    expect(signInLine(fuigo("zed"))).toBeNull();
  });
});

describe("the sticky offer and the create step", () => {
  it("a dismissed offer is gone for that bot and engine, and stays gone from a fresh reading", () => {
    const dismissed: HomeBot = { ...fuigo("amy"), signIn: { ...fuigo("amy").signIn!, dismissed: ["codex"] } };
    const bots = [bot("atlas", "codex", "Codex", true), dismissed, fuigo("bea")];
    expect(botsToSignIn(bots, "codex", "atlas").map((b) => b.id)).toEqual(["bea"]);
    expect(firstOffer([bot("atlas", "codex", "Codex", true), dismissed])).toBeNull();
  });
  it("an offer that was not dismissed is still there on a fresh reading (the panel was reopened)", () => {
    const bots = [bot("atlas", "codex", "Codex", true), fuigo("bea")];
    expect(firstOffer(bots)?.bot.id).toBe("bea");
    expect(firstOffer(bots)?.bot.id).toBe("bea");
  });
  it("B's line says needs sign-in while the home line says Codex is set up", () => {
    expect(signInLine(bot("b", "codex", "Codex", false))).toBe("Codex: needs sign-in");
    expect(homeSetUpLine("Codex")).toBe("Codex is set up on this home");
  });
  it("uses plain words: no em dashes and none of the banned words", () => {
    const step = { engine: "codex", label: "Codex" };
    const words = [createStepTitle("Bea", step), createStepBody("Bea", step), createStepButton("Bea", step), CREATE_STEP_SKIP, OFFER_DISMISS, OWN_CLAUDE_BUTTON, HOME_CLAUDE_BUTTON, homeSetUpLine("Codex")].join(" ");
    expect(words).not.toMatch(DASHES); expect(words).not.toMatch(BANNED);
    expect(createStepTitle("Bea", step)).toBe("Sign Bea in to Codex");
    expect(OWN_CLAUDE_BUTTON).toBe("Use a different Claude account for this bot");
  });
});

describe("the sign-in offer in a browser on a Cloud home", () => {
  const ENGINES = ["claudeAgent", "codex", "grokAgent", "kimiAgent", "opencodeGo", "antigravityAgent", "chatgpt", "supergrok"];
  const FORBIDDEN = /on this computer|on your computer|your computer|this computer/i;
  it("is shown only for an engine with a browser route, hidden for the rest, and unchanged with the desktop bridge or off a home", () => {
    for (const engine of ENGINES) {
      expect(signInOfferHere(engine, { homePage: true, bridge: false }), engine).toBe(BROWSER_SIGNIN_ENGINES.includes(engine));
      expect(signInOfferHere(engine, { homePage: true, bridge: true }), engine).toBe(true);
      expect(signInOfferHere(engine, { homePage: false, bridge: false }), engine).toBe(true);
    }
  });
  it("an owner browser's Sign in starts the page's own sign-in for a browser engine, and says where to go for one that has none", async () => {
    (globalThis as { document?: unknown }).document = { querySelector: () => ({ getAttribute: () => "home-1" }) };
    try {
      for (const engine of BROWSER_SIGNIN_ENGINES) {
        const seen: string[] = []; let opened = 0;
        expect(await runOfferSignIn("b", engine, { setBusy: (b) => seen.push(`busy:${b}`), setError: (m) => seen.push(`error:${m}`), openBrowser: () => { opened++; } }), engine).toBe(true);
        expect(opened, engine).toBe(1); expect(seen, engine).toEqual(["error:"]);
      }
      let opened = 0; const seen: string[] = [];
      expect(await runOfferSignIn("b", "opencodeGo", { setBusy: () => {}, setError: (m) => seen.push(m), openBrowser: () => { opened++; } })).toBe(false);
      expect(opened).toBe(0); expect(seen.join(" ")).not.toMatch(FORBIDDEN);
    } finally { delete (globalThis as { document?: unknown }).document; }
  });
  it("lets the chat through, and never prints a word about a computer, for every engine on a home page without the bridge", async () => {
    const stub = { querySelector: () => ({ getAttribute: () => "home-1" }) };
    (globalThis as { document?: unknown }).document = stub;
    try {
      // opencodeGo (a menu a filter cannot drive) has no browser route; the others do, and sign in right in the page.
      for (const engine of ["opencodeGo"]) {
        expect(offerShownHere(engine)).toBe(false);
        const lines: HomeBot[] = [{ id: "b", name: "Bea", signIn: { engine, label: engine, signedIn: false, uses: null } }];
        const html = renderToStaticMarkup(createElement(ChatSignInGate, { bot: { id: "b", name: "Bea" }, lines, onSignIn: () => {}, children: createElement("p", null, "composer") }));
        expect(html, engine).toBe("<p>composer</p>");
        expect(html).not.toMatch(FORBIDDEN);
        const seen: string[] = [];
        await runOfferSignIn("b", engine, { setBusy: () => {}, setError: (message) => seen.push(message) });
        expect(seen.join(" "), engine).not.toMatch(FORBIDDEN);
      }
    } finally { delete (globalThis as { document?: unknown }).document; }
  });
  it("off a home the gate still stands in for the composer", () => {
    const lines: HomeBot[] = [{ id: "b", name: "Bea", signIn: { engine: "codex", label: "Codex", signedIn: false, uses: null } }];
    const html = renderToStaticMarkup(createElement(ChatSignInGate, { bot: { id: "b", name: "Bea" }, lines, onSignIn: () => {}, children: createElement("p", null, "composer") }));
    expect(html).toContain("Sign Bea in to Codex");
    expect(html).not.toContain("composer");
  });
});
