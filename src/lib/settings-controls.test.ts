// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SETTINGS-1019 gate G1 (SETTINGS-NO-REGRESS-GATES-1019.md): every shipped Settings control survives. The generator
// below reads the app card registry (settings-card-registry.ts), the bot index (settings-index.ts), a scan of every
// data-setting and data-setting-control in src/components, and the G0 manifest (settings-controls.manifest.json:
// stored key, kind, default, id homes), and writes settings-controls.generated.json. The checks then assert that each
// shipped control has a home in the new model (designs/settings-model-1019.json: page, card or row, Simple or
// Advanced), the same kind and default, and a surface that still reaches it. A control with no home fails the build.
// Regenerate after a deliberate change:  SETTINGS_CONTROLS_WRITE=1 pnpm exec vitest run src/lib/settings-controls.test.ts
// Gaps the spec still has sit in the manifest's knownGaps with a reason; the test fails when a gap closes or a new one
// opens, so the list can only move on purpose (slice B closes them).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BOT_SETTINGS_CARDS, APP_SETTINGS_ENTRIES } from "./settings-index";
import { MERGED_CARD_ANCHORS, SETTINGS_CARD_ALIASES } from "./settings-card-registry";

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(path(rel), "utf8")) as T;

interface ManifestBotRow { kind: string; key: string; default?: boolean; why?: string }
interface KnownGap { why: string; dims: { dim: "kind" | "default"; shipped: unknown; spec: unknown }[] }
interface Manifest {
  appHomes: Record<string, string>;
  simpleCards: string[];
  simpleBotSections: string[];
  bot: Record<string, ManifestBotRow>;
  extraShipped: Record<string, ManifestBotRow>;
  kindMatches: Record<string, string[]>;
  knownGaps: Record<string, KnownGap>;
}
interface ModelCard { id: string; platforms: string[]; stub: string | null; controls?: { id: string; type: string; default?: unknown }[] }
interface ModelRow { id: string; type: string; default?: unknown }
interface Model { pages: { id: string; cards: ModelCard[] }[]; botSections: { id: string; rows: ModelRow[] }[] }

const MANIFEST = readJson<Manifest>("./settings-controls.manifest.json");
const MODEL = readJson<Model>("../../designs/settings-model-1019.json");
interface AppControl { control: string; kind: string; key: string; default: unknown; source: string; modelControl: string | null }
interface AppCards { cards: Record<string, { home: string; controls: AppControl[] }>; knownGaps: Record<string, KnownGap["dims"] | "no-model-control">; kindMatches: Record<string, string[]> }
const APP_CARDS = readJson<AppCards>("./settings-controls.appcards.json");

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${dir}/${entry.name}`) : entry.name.endsWith(".tsx") && !/\.test\./.test(entry.name) ? [`${dir}/${entry.name}`] : []);

/** Every data-setting id and data-setting-control anchor literal in the shipped components; dynamic ones are counted. */
function scanComponents() {
  const ids = new Set<string>(), anchors = new Set<string>();
  let dynamic = 0;
  for (const file of walk(path("../components"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/data-setting="([^"]+)"/g)) ids.add(match[1]!);
    for (const match of text.matchAll(/data-setting-control=(?:"([^"]+)"|\{([^}]*)\})/g)) { if (match[1]) anchors.add(match[1]); else dynamic += 1; }
  }
  return { ids: [...ids].sort(), anchors: [...anchors].sort(), dynamic };
}

const modelCards = new Map(MODEL.pages.flatMap((page) => page.cards.map((card) => [card.id, { page: page.id, card }] as const)));
const modelRows = new Map(MODEL.botSections.flatMap((section) => section.rows.map((row) => [row.id, { section: section.id, row }] as const)));
const SIMPLE = new Set(MANIFEST.simpleCards);

const appHome = (oldId: string) => {
  const cardId = MANIFEST.appHomes[oldId] ?? oldId, found = modelCards.get(cardId);
  return found ? { page: found.page, card: cardId, mode: SIMPLE.has(cardId) ? "Simple" : "Advanced" } : null;
};
const botHome = (id: string) => {
  const found = modelRows.get(id), section = id.split(".")[1]!;
  return found ? { page: "bot", section: found.section, row: id, mode: MANIFEST.simpleBotSections.includes(section) ? "Simple" : "Advanced" } : null;
};

function buildControls() {
  const scan = scanComponents();
  // The merged About rows are search addresses inside the retained card, not cards with controls of their own.
  const app = APP_SETTINGS_ENTRIES.filter((entry) => !Object.hasOwn(SETTINGS_CARD_ALIASES, entry.id)).map((entry) => ({ id: entry.id, section: entry.section, anchor: entry.anchor, advanced: entry.advanced, surface: entry.surface, label: entry.label(), home: appHome(entry.id) }));
  const rowIds = [...new Set([...BOT_SETTINGS_CARDS.map((entry) => entry.id), "bot.voice.calls"])];
  const bot = rowIds.map((id) => {
    const manifest = MANIFEST.bot[id.slice(4)] ?? null;
    const index = BOT_SETTINGS_CARDS.find((entry) => entry.id === id);
    return { id, indexed: Boolean(index), anchor: index?.anchor ?? "bot-setting-calls", surface: index?.surface ?? "desktop", label: index?.label() ?? "Calls", kind: manifest?.kind ?? null, key: manifest?.key ?? null, default: manifest?.default ?? null, home: botHome(id) };
  });
  const extra = Object.entries(MANIFEST.extraShipped).map(([id, row]) => ({ id, kind: row.kind, key: row.key, default: row.default ?? null, why: row.why, home: botHome(id) }));
  const anchorOwner = new Map<string, string>([...app.map((row) => [row.anchor, row.id] as const), ...bot.map((row) => [row.anchor, row.id] as const)]);
  for (const [inner, outer] of Object.entries(MERGED_CARD_ANCHORS)) if (anchorOwner.has(outer)) anchorOwner.set(inner, anchorOwner.get(outer)!);
  const controlHomes = scan.anchors.map((anchor) => ({ anchor, owner: anchorOwner.get(anchor) ?? null }));
  const appControls = app.flatMap((row) => (APP_CARDS.cards[row.id]?.controls ?? []).map((control) => ({ card: row.id, ...control })));
  return { generatedBy: "src/lib/settings-controls.test.ts (SETTINGS_CONTROLS_WRITE=1)", counts: { app: app.length, bot: bot.length, botIndexed: BOT_SETTINGS_CARDS.length, dataSetting: scan.ids.length, controlAnchors: scan.anchors.length, dynamicControlAnchors: scan.dynamic }, dataSetting: scan.ids, controlAnchors: scan.anchors, controlHomes, appControls, app, bot, extra };
}

const GENERATED = new URL("./settings-controls.generated.json", import.meta.url);
const built = buildControls();
if (process.env.SETTINGS_CONTROLS_WRITE === "1") writeFileSync(GENERATED, `${JSON.stringify(built, null, 2)}\n`);

describe("settings control survival (G1)", () => {
  it("the generated file is current (regenerate on a deliberate change)", () => {
    expect(JSON.parse(readFileSync(GENERATED, "utf8"))).toEqual(JSON.parse(JSON.stringify(built)));
  });

  it("knows every shipped control from both page lanes, including memory.browser and connections.claude-code", () => {
    expect(built.counts).toMatchObject({ app: 84, bot: 37, botIndexed: 37, dataSetting: 37 });
    expect(built.dataSetting).toEqual(built.bot.map((row) => row.id).sort());
  });

  it("gives every shipped app card a home: page, card, Simple or Advanced", () => {
    expect(built.app.filter((row) => !row.home).map((row) => row.id)).toEqual([]);
    for (const simple of MANIFEST.simpleCards) expect(modelCards.has(simple), `simple card ${simple} is in the model`).toBe(true);
  });

  it("gives every shipped bot row a home and a stored key from the G0 manifest", () => {
    expect(built.bot.filter((row) => !row.home).map((row) => row.id)).toEqual([]);
    expect(built.bot.filter((row) => !row.key || !row.kind).map((row) => row.id)).toEqual([]);
    expect(built.extra.filter((row) => !row.home).map((row) => row.id)).toEqual([]);
  });

  it("keeps every control reachable where it was: an everywhere card still reaches phone and Cloud, or says why", () => {
    const lost = built.app.filter((row) => {
      if (row.surface !== "any" || !row.home) return false;
      const card = modelCards.get(row.home.card)!.card;
      return !(["P", "C"].every((surface) => card.platforms.includes(surface)) || card.stub === "onComputer");
    }).map((row) => row.id);
    expect(lost).toEqual([]);
  });

  it("keeps every scanned control inside a card or bot row that has a home, and no home card is an empty shell", () => {
    expect(built.controlHomes.filter((entry) => !entry.owner).map((entry) => entry.anchor)).toEqual([]);
    const owners = new Set(built.controlHomes.map((entry) => entry.owner!));
    for (const row of built.app) if (owners.has(row.id)) expect(modelCards.get(row.home!.card)!.card.controls?.length ?? 0, `${row.id} home ${row.home!.card} has controls`).toBeGreaterThan(0);
  });

  it("keeps the kind and the default of every bot row; the recorded spec gaps are exact (dimension, shipped, spec) and can only move on purpose", () => {
    const found: Record<string, KnownGap["dims"]> = {};
    for (const row of [...built.bot, ...built.extra]) {
      const model = modelRows.get(row.id)?.row;
      if (!model || !row.kind) continue;
      const dims: KnownGap["dims"] = [];
      if (!(MANIFEST.kindMatches[row.kind] ?? [row.kind]).includes(model.type)) dims.push({ dim: "kind", shipped: row.kind, spec: model.type });
      if (row.default !== null && row.default !== undefined && JSON.stringify(row.default) !== JSON.stringify(model.default ?? null)) dims.push({ dim: "default", shipped: row.default, spec: model.default ?? null });
      if (dims.length) found[row.id] = dims;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(MANIFEST.knownGaps).map(([id, gap]) => [id, gap.dims])));
    for (const [id, gap] of Object.entries(MANIFEST.knownGaps)) expect(gap.why.length, `${id} says why`).toBeGreaterThan(20);
  });

  it("lists every control of every shipped app card with its stored key, kind and default (the app-card manifest)", () => {
    expect(Object.keys(APP_CARDS.cards).sort()).toEqual(built.app.map((row) => row.id).sort());
    const bad = built.appControls.filter((control) => !control.key || !control.kind || !control.source || !control.control).map((control) => `${control.card}::${control.control}`);
    expect(bad).toEqual([]);
    expect(built.app.filter((row) => !(APP_CARDS.cards[row.id]?.controls.length)).map((row) => row.id)).toEqual([]);
    for (const row of built.app) expect(APP_CARDS.cards[row.id]!.home, row.id).toBe(row.home?.card);
  });

  it("keeps the model control, kind and default of every app-card control; the recorded gaps are exact and can only move on purpose", () => {
    const found: Record<string, KnownGap["dims"] | "no-model-control"> = {};
    for (const control of built.appControls) {
      const home = modelCards.get(APP_CARDS.cards[control.card]!.home)!.card;
      const id = `${control.card}::${control.control}`;
      const model = control.modelControl ? home.controls?.find((candidate) => candidate.id === control.modelControl) : undefined;
      if (!model) { found[id] = "no-model-control"; continue; }
      const dims: KnownGap["dims"] = [];
      if (!(APP_CARDS.kindMatches[control.kind] ?? [control.kind]).includes(model.type)) dims.push({ dim: "kind", shipped: control.kind, spec: model.type });
      if (control.default !== null && control.default !== undefined && JSON.stringify(control.default) !== JSON.stringify(model.default ?? null)) dims.push({ dim: "default", shipped: control.default, spec: model.default ?? null });
      if (dims.length) found[id] = dims;
    }
    expect(found).toEqual(APP_CARDS.knownGaps);
  });
});
