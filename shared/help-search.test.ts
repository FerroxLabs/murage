import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELP_INDEX } from "./help-index.ts";
import { searchHelp, helpTopics, tokenize, stem, type HelpEntry } from "./help-search.ts";

const CORPUS: readonly HelpEntry[] = [
  {
    id: "features/automation#routines", title: "Routines and webhooks",
    description: "Run work on a schedule.", heading: "Routines",
    breadcrumb: "Murage docs → Features → Routines and webhooks",
    where: "Murage docs → Features → Routines and webhooks",
    url: "https://murage.app/docs/features/automation#routines",
    text: "A routine runs a bot on a schedule you choose. Paused routines never fire.",
  },
  {
    id: "security/permissions#approval-cards", title: "Permissions and secrets",
    description: "How approvals are handled.", heading: "Approval cards",
    breadcrumb: "Murage docs → Security → Permissions and secrets",
    where: "Settings → Permissions",
    url: "https://murage.app/docs/security/permissions-and-secrets#approval-cards",
    text: "Murage shows a permission request inline and records the outcome. Do not paste API keys into chat.",
  },
  {
    id: "features/voice#memory", title: "Voice and memory",
    description: "Inspect what agents remember.", heading: "Memory",
    breadcrumb: "Murage docs → Features → Voice and memory",
    where: "Murage docs → Features → Voice and memory",
    url: "https://murage.app/docs/features/voice-and-memory#memory",
    text: "Each bot can keep plain-text memory you can inspect, correct, or delete.",
  },
];

describe("help search", () => {
  it("finds the section that answers the question", () => {
    expect(searchHelp("how do I schedule a recurring job", { corpus: CORPUS })[0].id).toBe("features/automation#routines");
    expect(searchHelp("can you remember what I told you", { corpus: CORPUS })[0].id).toBe("features/voice#memory");
    expect(searchHelp("do I have to approve things", { corpus: CORPUS })[0].id).toBe("security/permissions#approval-cards");
  });

  it("folds the endings product prose varies", () => {
    expect(stem("approve")).toBe(stem("approval"));
    expect(stem("approvals")).toBe(stem("approval"));
    expect(stem("routine")).toBe(stem("routines"));
    expect(stem("connection")).toBe(stem("connect"));
    // and does not fold words that merely start alike
    expect(stem("costume")).not.toBe(stem("cost"));
  });

  it("returns nothing for a question the docs do not touch", () => {
    expect(searchHelp("what is the capital of Peru", { corpus: CORPUS })).toEqual([]);
    expect(searchHelp("", { corpus: CORPUS })).toEqual([]);
    expect(searchHelp("the a of", { corpus: CORPUS })).toEqual([]);
  });

  it("honours the limit and clamps it to a sane range", () => {
    expect(searchHelp("murage", { corpus: CORPUS, limit: 1 }).length).toBeLessThanOrEqual(1);
    expect(searchHelp("routine memory permission", { corpus: CORPUS, limit: 99 }).length).toBeLessThanOrEqual(5);
  });

  it("is deterministic — the same question gives the same answer", () => {
    const once = searchHelp("schedule a routine", { corpus: CORPUS });
    const twice = searchHelp("schedule a routine", { corpus: CORPUS });
    expect(once).toEqual(twice);
  });

  it("lists every documented topic once when there is no question", () => {
    const topics = helpTopics(CORPUS);
    expect(topics).toHaveLength(3);
    expect(new Set(topics).size).toBe(3);
    expect(topics[0]).toContain("Routines and webhooks");
  });

  it("tokenize drops noise but keeps product words", () => {
    expect(tokenize("How do I use Murage?")).toEqual(["use"]);
    expect(tokenize("connect a model provider")).toEqual(["connect", "model", "provider"]);
  });
});

describe("the shipped index", () => {
  it("covers the whole documentation set", () => {
    expect(HELP_INDEX.length).toBeGreaterThan(80);
    expect(new Set(HELP_INDEX.map((entry) => entry.title)).size).toBeGreaterThan(25);
  });

  it("never carries a path the user cannot act on", () => {
    // A path in the user's own home ("~/.murage/config.json") is documented
    // and actionable, so it is allowed. A path inside this repository, a
    // machine-specific absolute path, or a source filename is not: the person
    // reading a help answer has the app, not the checkout.
    for (const entry of HELP_INDEX) {
      for (const field of [entry.where, entry.url, entry.text, entry.title]) {
        expect(field, entry.id).not.toMatch(/\/Users\/|\/Volumes\/|\/home\/[a-z]|[A-Z]:\\\\|apps\/docs\/|\bserver\/|\.mdx\b|node_modules/);
      }
      expect(entry.url.startsWith("https://"), entry.id).toBe(true);
    }
  });

  it("keeps every quote short enough to paste into a chat reply", () => {
    for (const entry of HELP_INDEX) expect(entry.text.length, entry.id).toBeLessThanOrEqual(701);
  });

  it("holds no unrendered MDX", () => {
    for (const entry of HELP_INDEX) {
      expect(entry.text, entry.id).not.toMatch(/<[A-Za-z][^>]*>|^import |```/m);
    }
  });

  it("answers the real questions people ask about Murage", () => {
    const expectations: Array<[string, RegExp]> = [
      ["how do I add a bot", /bot|agent/i],
      ["what engines can I use", /engine|provider/i],
      ["where do connected apps live", /connected app|composio/i],
      ["how does memory work", /memory|remember/i],
      ["is my data sent anywhere", /local|data|security/i],
      ["how do routines run on a schedule", /routine|schedule/i],
    ];
    for (const [question, shape] of expectations) {
      const results = searchHelp(question);
      expect(results.length, question).toBeGreaterThan(0);
      expect(results.map((result) => `${result.title} ${result.heading ?? ""} ${result.text}`).join(" "), question).toMatch(shape);
    }
  });

  it("is regenerated from the docs, never edited by hand", () => {
    const script = fileURLToPath(new URL("../scripts/build-help-index.mjs", import.meta.url));
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
