// FIRST RUN MAKES NO PROMISE ABOUT WHERE TYPED TEXT GOES (1.0.12).
//
// Three Astra reviews of L6A blocked on the same line: the first run told
// people their typed words stay on their computer, and every place it said so
// could be reached while the Chief's turns went to a cloud model, a provider
// connection, a server on another computer, or an engine that refuses local
// models. 1.0.12 drops the promise everywhere in first run. It comes back only
// with a design that ties it to the Chief's real engine and model.
//
// This reads what a person can SEE: every card variant rendered against
// machines that used to earn the line, every string in the first-run copy,
// and every locale pack, so a translation or a new tooltip cannot bring it
// back by another route.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let setupReply: unknown = {};
vi.mock("@/state/store", () => ({
  api: async (path: string) => (path === "/api/setup" ? setupReply : {}),
  useStore: () => ({ state: {}, dispatch: () => {} }),
}));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
vi.mock("@/lib/analytics", () => ({ identifyEmail: () => {}, setEmailGateDone: () => {} }));

const { FirstRunCard } = await import("./FirstRunCard");
const { readSetupView, forgetSetupView } = await import("./FirstRunChrome");
const { FIRST_RUN_COPY } = await import("@/lib/first-run-copy");
const { SETUP_CARD_VARIANTS, setupCardKey } = await import("../../shared/setup-card");

/** Every form of the promise this release does not make, in every pack's
 *  language. Matched case-insensitively against what a person reads. */
const PRIVACY_PROMISE: readonly RegExp[] = [
  /nothing (that )?you (type|write|say|send|share)/i,
  /what(ever)? you (type|write|say) (stays|never|does not|doesn['’]t|won['’]t)/i,
  /\b(no|nothing|none)\b[^.]{0,40}\bleaves? (this|your) (own )?(computer|machine|device|mac|pc|laptop)/i,
  /\b(never|not|n['’]t) (leave|leaves) (this|your) (computer|machine|device|mac|pc|laptop)/i,
  /\bnever leaves\b/i,
  /\bstays? (here )?on (this|your) (own )?(computer|machine|device|mac|pc|laptop)/i,
  /\b(what you type|your (words|messages|chats|text|typing)|everything( you type)?) (stays?|is kept|are kept) (completely |fully |entirely )?(private|local|offline|here)\b/i,
  /\b(100%|fully|completely|entirely) (local|private|offline)\b/i,
  /\b(messages|words|text|what you type|chats|typing)\b[^.]{0,30}\b(stay|stays|remain|remains)\b[^.]{0,15}\b(on|in) (this|your) (own )?(computer|machine|device|mac|pc|laptop)/i,
  // de, fr, es, pt-BR, ja, zh, hi
  /bleib(t|en) auf (diesem|deinem|ihrem) (computer|rechner|gerät)/i,
  /rest(e|ent) sur (cet|votre) (ordinateur|appareil)/i,
  /verl(ä|ae)sst (nie(mals)? )?(diesen|deinen|ihren|den) (computer|rechner)/i,
  /ne quitte (jamais |pas )?(cet|votre|l['’]) ?ordinateur/i,
  /\bsale de (este|tu|su) (equipo|ordenador|computador|computadora)/i,
  /\bsai d(este|o seu|o) computador/i,
  /このコンピューター(の外|から出|を離れ)/,
  /(离开|離開)(这台|此|這台)(电脑|计算机|電腦)/,
  /इस कंप्यूटर (से बाहर|को नहीं छोड़)/,
];

const found = (text: string): string[] => PRIVACY_PROMISE.filter((re) => re.test(text)).map(String);

/** The words as a person reads them: tags, attributes and entities decoded,
 *  titles and aria labels kept, because a tooltip is copy too. */
function readable(markup: string): string {
  const attrs = [...markup.matchAll(/\s(?:title|aria-label|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]);
  return [markup.replace(/<[^>]*>/g, " "), ...attrs].join(" ")
    .replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

async function machine(view: Record<string, unknown>): Promise<void> {
  setupReply = { steps: [], agents: [], signedOutAgents: [], ownerName: "", ...view };
  forgetSetupView();
  await readSetupView(true);
}

const bot = { id: "chief", threadId: "thread-1", name: "Chief of Staff" } as Parameters<typeof FirstRunCard>[0]["bot"];
const render = (variant: string, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(FirstRunCard, {
    bot,
    message: {
      id: `card-${variant}`,
      role: "bot",
      kind: "options",
      at: 1,
      card: { title: "Setup", options: [], setup: { step: "flow", variant, key: setupCardKey("flow" as never, variant as never), ...extra } },
    } as unknown as Parameters<typeof FirstRunCard>[0]["message"],
  }));

const LOCAL = { id: "ollama", name: "generic", installed: true, localModel: { model: "qwen3:8b", host: "Ollama" } };

/** The machines that used to earn the promise, and the ones that wrongly did. */
const MACHINES: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["the Chief on a local model on this computer", { ownerName: "Sean", agents: [LOCAL], chiefInstanceId: "ollama", chiefLocalModel: { model: "qwen3:8b", host: "Ollama" } }],
  ["a local engine, the Chief on a cloud model", { agents: [LOCAL], chiefInstanceId: "ollama" }],
  ["a local engine beside a cloud engine the Chief is on", { agents: [LOCAL, { id: "claude", name: "Claude Code", installed: true }], chiefInstanceId: "claude" }],
  ["a local engine, Flux connected", { agents: [LOCAL], fluxReady: true, chiefInstanceId: "ollama" }],
  ["a bare machine", { agents: [], nothingToThinkWith: true }],
];

describe("first run makes no promise that typed text stays on this computer", () => {
  it("in any card, on any machine, open or settled", async () => {
    for (const [label, view] of MACHINES) {
      await machine(view);
      for (const variant of SETUP_CARD_VARIANTS) {
        for (const extra of [{}, { settled: true }]) {
          const text = readable(render(variant, extra));
          expect.soft(found(text), `${variant} on ${label}: ${text.slice(0, 200)}`).toEqual([]);
        }
      }
    }
  });

  it("in any first-run copy string, including the ones built from names", () => {
    const hits: string[] = [];
    const walk = (value: unknown, path: string, depth = 0): void => {
      if (depth > 12) return;
      if (typeof value === "string") {
        if (found(value).length) hits.push(`${path}: ${value}`);
      } else if (typeof value === "function") {
        for (const args of [["qwen3:8b", "Ollama", "Sean"], [2, 3, 4]]) {
          try {
            const out = (value as (...a: unknown[]) => unknown)(...args);
            if (typeof out === "string" && found(out).length) hits.push(`${path}(): ${out}`);
          } catch { /* a builder that wants another shape says nothing here */ }
        }
      } else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`, depth + 1);
      }
    };
    walk(FIRST_RUN_COPY, "FIRST_RUN_COPY");
    expect(hits).toEqual([]);
  });

  it("in any locale pack, English and the seven translations, and the staged UX copy", () => {
    const dir = fileURLToPath(new URL("../locales/", import.meta.url));
    const files: string[] = [];
    const collect = (at: string): void => {
      for (const name of readdirSync(at)) {
        const full = join(at, name);
        if (statSync(full).isDirectory()) collect(full);
        else if (name.endsWith(".json") && name !== "source-hashes.json") files.push(full);
      }
    };
    collect(dir);
    const packs = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"];
    for (const code of packs) expect(files.some((file) => file.endsWith(`${code}.json`)), code).toBe(true);
    // Outside first run, and about stored credentials rather than what a
    // person types: the WhatsApp risk note says where the linked session
    // lives. Named here so nothing else can hide behind it.
    const notFirstRun = new Set(["whatsapp.risk.local"]);
    const hits: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") { if (found(value).length && !notFirstRun.has(path.slice(path.indexOf("::") + 2))) hits.push(`${path}: ${value}`); }
      else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
    };
    for (const file of files) {
      const pack = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [key, value] of Object.entries(pack)) walk(value, `${file.slice(dir.length)}::${key}`);
    }
    expect(hits).toEqual([]);
  });

  it("the patterns catch every form the earlier builds shipped", () => {
    for (const line of [
      "Nothing you type leaves this computer.",
      "Found qwen3:8b running on this computer, and I am using it now. Nothing you type leaves this computer.",
      "What you type stays on this computer.",
      "Your words never leave your computer.",
      "Everything stays private.",
      "No text leaves this computer.",
      "Your messages remain on your device.",
      "Deine Nachrichten bleiben auf deinem Computer.",
      "Vos messages restent sur votre ordinateur.",
      "Nichts, was du eingibst, verlässt diesen Computer.",
      "Rien de ce que vous tapez ne quitte cet ordinateur.",
      "Nada de lo que escribes sale de este equipo.",
      "Nada do que você digita sai deste computador.",
      "入力した内容はこのコンピューターの外に出ません。",
      "你输入的内容不会离开这台电脑。",
      "आप जो टाइप करते हैं वह इस कंप्यूटर से बाहर नहीं जाता।",
    ]) expect.soft(found(line), line).not.toEqual([]);
    // And the neutral lines that replace it are not caught.
    for (const line of [FIRST_RUN_COPY.agents.detect.localDetail, FIRST_RUN_COPY.agents.detect.localChief("qwen3:8b")]) {
      expect.soft(found(line), line).toEqual([]);
    }
  });
});
