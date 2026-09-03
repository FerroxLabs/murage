// The paste-and-extract surface. What it must never render, what it must
// refuse to save, and the fact that a suggestion is not an action.
//
// Every key here is obviously fake and written out in full. Nothing reads
// process.env: a fixture holding a developer's real key would prove nothing
// about the request that does not.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KeyCandidate, ProviderId } from "../../shared/key-extract";
import { extractKeys } from "../../shared/key-extract";

// desktop.ts reads `window` at module scope and @/lib/analytics boots
// posthog-js on import; neither survives a node-env import of the component.
Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false,
  setAnalyticsEnabled: () => {},
  initAnalytics: () => {},
  track: () => {},
}));

const { PasteKeysBody, rowTarget } = await import("./PasteKeys");
type Props = Parameters<typeof PasteKeysBody>[0];
type Row = Props["rows"][number];

const FLUX = `sk-flux-${"F".repeat(40)}`;
const XAI = `xai-${"7".repeat(32)}`;
const BARE = `sk-${"o".repeat(40)}`;
const ANTHROPIC = `sk-ant-api03-${"a".repeat(40)}`;

const candidate = (blob: string): KeyCandidate => {
  const found = extractKeys(blob);
  expect(found, blob.slice(0, 24)).toHaveLength(1);
  return found[0]!;
};

const row = (blob: string, over: Partial<Row> = {}): Row => ({
  candidate: candidate(blob),
  chosen: null,
  status: "pending",
  error: null,
  ...over,
});

const render = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(
    createElement(PasteKeysBody, {
      rows: [],
      scanned: false,
      onScan: vi.fn(),
      onChoose: vi.fn(),
      onAccept: vi.fn(),
      onDismiss: vi.fn(),
      configured: null,
      ...over,
    }),
  );

const source = readFileSync(fileURLToPath(new URL("./PasteKeys.tsx", import.meta.url)), "utf8");

describe("no key ever reaches the screen", () => {
  it("renders the hint and not the key, in every state a row can be in", () => {
    // One row per state the component knows how to draw, all at once, so a
    // leak in any single branch turns this red.
    const rows: Row[] = [
      row(`FLUX_API_KEY=${FLUX}`),
      row(`XAI_API_KEY=${XAI}`, { status: "saving" }),
      row(`my key is ${BARE}`),
      row(`my key is ${BARE}`, { chosen: "imageGen" as ProviderId }),
      row(`ANTHROPIC_API_KEY=${ANTHROPIC}`),
      row(`FLUX_API_KEY=${FLUX}`, { error: "the harness said no" }),
    ];
    const html = render({ rows, scanned: true, configured: { flux: { configured: true } } });

    // The rows are actually on screen — otherwise every assertion below would
    // pass by rendering nothing at all.
    expect(html.match(/data-testid="paste-key-row"/g) ?? []).toHaveLength(rows.length);
    expect(html).toContain("Flux Router key");
    expect(html).toContain("Anthropic key");

    // THE assertion. Deliberately first, so a component that renders the key
    // fails here and says so, rather than tripping a milder check on the way.
    for (const key of [FLUX, XAI, BARE, ANTHROPIC]) {
      expect(html, `full key leaked: ${key.slice(0, 10)}…`).not.toContain(key);
      // Not even most of it. `not.toContain(key)` alone would pass on a
      // component that rendered all but the final character.
      expect(html, `key body leaked: ${key.slice(0, 10)}…`).not.toContain(key.slice(0, key.length - 4));
      expect(html, `key middle leaked: ${key.slice(0, 10)}…`).not.toContain(key.slice(8, 32));
    }

    // Four characters of each key, and not one more.
    expect(html).toContain("••••FFFF");
    expect(html).toContain("••••7777");
    expect(html).toContain("••••oooo");
    expect(html).toContain("••••aaaa");
  });

  it("has no prop, and no state, that the pasted blob could live in", () => {
    // The textarea is uncontrolled and read once through a ref. A `blob` prop
    // would put somebody's whole .env into the render tree.
    // The box renders empty, always: there is no path by which a previous
    // paste could be drawn back into it.
    expect(render({ rows: [row(`FLUX_API_KEY=${FLUX}`)], scanned: true })).toMatch(
      /<textarea[^>]*><\/textarea>/,
    );
    expect(source).toContain('defaultValue=""');
    expect(source).not.toMatch(/<textarea[^>]*\svalue=\{/);
    expect(source).toMatch(/el\.value = "";/);
    // And there is no useState holding it.
    expect(source).not.toMatch(/useState[^\n]*blob/i);
  });

  it("never logs, never titles and never placeholders a key", () => {
    expect(source).not.toMatch(/console\.(log|warn|error|debug)/);
    // `candidate.value` appears only where a key is legitimately needed: the
    // save call, the emptiness guards around it, and the blanking afterwards.
    const uses = source.match(/candidate\.value/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(source).toContain("maskKey(candidate.value)");
    expect(source).not.toMatch(/\{\s*candidate\.value\s*\}/);
    expect(source).not.toMatch(/\{\s*row\.candidate\.value\s*\}/);
  });

  it("blanks the key out of a row the moment it is finished with", () => {
    expect(source).toMatch(/candidate: \{ \.\.\.row\.candidate, value: "" \}/);
    expect(source).toMatch(/spent\(current, "saved", null\)/);
    expect(source).toMatch(/spent\(current, "dismissed", null\)/);
  });

  it("shows only four dots for a key too short to hint at", () => {
    // A short value never gets a tail, so the mask cannot become the key.
    const short: Row = {
      candidate: { value: "sk-short123", hint: "", providers: ["flux"], evidence: "shape" },
      chosen: null,
      status: "pending",
      error: null,
    };
    const html = render({ rows: [short], scanned: true });
    expect(html).toContain("••••<");
    expect(html).not.toContain("sk-short123");
  });
});

describe("extraction is a suggestion, never an action", () => {
  it("cannot save a row whose provider is still a question", () => {
    const html = render({ rows: [row(`my key is ${BARE}`)], scanned: true });
    expect(html).toContain("Which key is this?");
    expect(html).toContain("Pick which key this is first");
    expect(html).toContain("disabled=");
    // POSITIVE control: the same rig DOES offer to save an unambiguous row,
    // so the refusal above is the rule and not the renderer being broken.
    const decided = render({ rows: [row(`FLUX_API_KEY=${FLUX}`)], scanned: true });
    expect(decided).not.toContain("Pick which key this is first");
    expect(decided).not.toContain("disabled=");
  });

  it("offers every possible provider and pre-selects none of them", () => {
    const html = render({ rows: [row(`my key is ${BARE}`)], scanned: true });
    for (const label of ["OpenAI-compatible engine key", "OpenAI key for avatars", "Flux Router key"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain('aria-pressed="true"');
  });

  it("becomes saveable once the person has picked", () => {
    const picked = render({
      rows: [row(`my key is ${BARE}`, { chosen: "imageGen" as ProviderId })],
      scanned: true,
    });
    expect(picked).toContain('aria-pressed="true"');
    expect(picked).not.toContain("Pick which key this is first");
    expect(picked).not.toContain("disabled=");
  });

  it("offers no save at all for a key Murage cannot store", () => {
    const html = render({ rows: [row(`ANTHROPIC_API_KEY=${ANTHROPIC}`)], scanned: true });
    expect(html).toContain("Anthropic key");
    expect(html).toContain("Claude CLI&#x27;s own login");
    expect(html).not.toContain("Save this key");
    // Ignoring it is the only thing on offer.
    expect(html).toContain("Ignore");
  });

  it("resolves a row's destination only when there is exactly one", () => {
    expect(rowTarget(row(`FLUX_API_KEY=${FLUX}`))).toBe("flux");
    expect(rowTarget(row(`my key is ${BARE}`))).toBeNull();
    expect(rowTarget(row(`my key is ${BARE}`, { chosen: "flux" as ProviderId }))).toBe("flux");
    expect(rowTarget(row(`ANTHROPIC_API_KEY=${ANTHROPIC}`))).toBeNull();
  });
});

describe("each key is confirmed on its own", () => {
  it("draws one row per key and leaves the rest alone when one is ignored", () => {
    const rows: Row[] = [
      row(`FLUX_API_KEY=${FLUX}`),
      row(`XAI_API_KEY=${XAI}`, { status: "dismissed" }),
      row(`my key is ${BARE}`),
    ];
    const html = render({ rows, scanned: true });
    expect(html.match(/data-testid="paste-key-row"/g) ?? []).toHaveLength(2);
    expect(html).toContain("2 keys found");
    // The ignored one is gone, hint and all.
    expect(html).not.toContain("••••7777");
    expect(html).toContain("••••FFFF");
  });

  it("counts one key as one key", () => {
    expect(render({ rows: [row(`FLUX_API_KEY=${FLUX}`)], scanned: true })).toContain("1 key found");
  });

  it("says so plainly when a scan recognised nothing", () => {
    expect(render({ scanned: true, rows: [] })).toContain("Nothing recognised");
    // Before the first scan it says nothing of the kind.
    expect(render({ scanned: false, rows: [] })).not.toContain("Nothing recognised");
  });

  it("surfaces one row's failure without touching the others", () => {
    const html = render({
      rows: [row(`FLUX_API_KEY=${FLUX}`, { error: "the harness said no" }), row(`XAI_API_KEY=${XAI}`)],
      scanned: true,
    });
    expect(html).toContain("the harness said no");
    expect(html.match(/the harness said no/g) ?? []).toHaveLength(1);
  });
});

describe("a key that is already saved is shown as saved", () => {
  it("says connected and offers to replace rather than silently re-saving", () => {
    const html = render({
      rows: [row(`FLUX_API_KEY=${FLUX}`)],
      scanned: true,
      configured: { flux: { configured: true } },
    });
    expect(html).toContain("Already connected");
    expect(html).toContain("Replace");
    expect(html).toContain("Saving replaces the key already there.");
    // POSITIVE control: with nothing saved it is a plain Save.
    const empty = render({ rows: [row(`FLUX_API_KEY=${FLUX}`)], scanned: true, configured: { flux: { configured: false } } });
    expect(empty).not.toContain("Already connected");
    expect(empty).toContain("Save");
  });

  it("never claims connected from a config that has not loaded", () => {
    expect(render({ rows: [row(`FLUX_API_KEY=${FLUX}`)], scanned: true, configured: null })).not.toContain(
      "Already connected",
    );
  });
});

describe("it saves the way the rest of the app saves", () => {
  it("uses the OS-backed store when the shell offers one, and the config route otherwise", () => {
    const apiKeys = readFileSync(fileURLToPath(new URL("./ApiKeys.tsx", import.meta.url)), "utf8");
    // The same two doors, in the same order, as the existing key rows.
    expect(apiKeys).toContain("window.muragebox?.setCredential");
    expect(source).toContain("window.muragebox?.setCredential");
    expect(source).toMatch(/api\("\/api\/config", \{ method: "PUT", body: JSON\.stringify\(provider\.body\(value\)\) \}\)/);
  });

  it("has no way to read a saved key back out of config", () => {
    // GET /api/config answers presence flags, so there is no field a key
    // could arrive in. This asserts the component never reaches for one.
    expect(source).toContain("state.config ?? null");
    expect(source).not.toMatch(/config[^\n]*\.(apiKey|token)\b/);
  });
});
