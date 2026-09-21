import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { FluxKeyCardBody } = await import("./FluxKeyCard");
const { FluxRouterConnection } = await import("./FluxRouterConnection");
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const pointer = read("./FluxKeyCard.tsx"), canonical = read("./FluxRouterConnection.tsx"), models = read("./ModelsSettings.tsx");
const renderCanonical = (configured: boolean) => renderToStaticMarkup(createElement(FluxRouterConnection, { configured, onSave: async () => {}, onTest: async () => ({ modelCount: 0 }), onDisconnect: async () => {} }));

describe("setup links to one Flux key editor", () => {
  it("renders only a keyboard-accessible navigation action", () => {
    const html = renderToStaticMarkup(createElement(FluxKeyCardBody, { onOpen: vi.fn() }));
    expect(html).toContain('type="button"'); expect(html).toContain("Open Flux Router in Models");
    expect(html).not.toMatch(/<input|<form|<textarea/); expect(html).toContain("focus-visible:ring-2");
  });
  it("never holds or writes a key in the setup pointer", () => {
    expect(pointer).not.toMatch(/api\(|fluxKeyPatch|apiKey|useState|type="password"/);
    expect(pointer).toContain('dispatch({ type: "toggleAppSettings", open: true, section: "models" })');
  });
  it("keeps the canonical typed field masked and write-only", () => {
    expect(renderCanonical(false)).toContain('type="password"');
    expect(canonical).not.toContain('type="text"'); expect(canonical).not.toMatch(/config[^\n]*apiKey/);
    expect(canonical).toContain('input.current.value = ""');
  });
  it("shows a saved key only as status, without rendering its field", () => {
    expect(renderCanonical(true)).toContain("Connected · key saved");
    expect(renderCanonical(true)).not.toContain("<input"); expect(renderCanonical(false)).not.toContain("Connected · key saved");
  });
  it("keeps explicit disconnect separate from an empty replacement", () => {
    expect(canonical).toContain('if (kind === "save" && !key)');
    expect(canonical).toContain("Disconnect Flux Router?"); expect(canonical).toContain("Keep connected");
  });
  it("keeps error feedback and official signup on the canonical form", () => {
    expect(canonical).toContain('role="alert"'); expect(canonical).toContain('role="status"');
    expect(renderCanonical(false)).toContain("https://fluxrouter.ai/auth/sign-up");
  });
  it("removes the legacy Flux fallback writer even when status is unavailable", () => {
    expect(models).toContain('<FluxRouterConnection configured={flux?.configured ?? null}');
    expect(models).not.toContain('<ExistingKey id="legacy-flux"');
    expect(models).not.toContain('{ flux: { apiKey: value } }');
    expect(models).toContain("Your saved keys are unchanged.");
    expect(models).toContain("Saved Flux connection:");
  });
  // WHAT REPLACED FluxInvite.tsx AND Onboarding.tsx.
  //
  // Both were deleted when the three stacked first-run surfaces collapsed
  // into one conversation with the Chief of Staff. The two rules they carried
  // are not deleted with them, so they are asserted here against the things
  // that took their place: FirstRunFluxCard.tsx, which is where the key is
  // asked for now, and FirstRunPhases.tsx, the chrome around the flow that
  // offers it (FirstRunRail.tsx, which used to carry this rule, was replaced
  // by the phase bar).
  it("routes the avatar hint to Models, and keeps the first run's key field on the one road", () => {
    // The invitation used to hold no field and point at Models instead. The
    // card in the chat does hold a field, which is the whole improvement, so
    // the rule it inherits is the one that actually protected the key: one
    // writer (`saveAndProveFluxKey`, which is `saveFluxKey`, the Settings
    // card's own road into the keychain, with the live check bolted on after
    // it), masked, dropped from React the moment it is stored, never
    // rendered back.
    expect(read("./BotProfileAvatarCard.tsx")).toContain('section: "models"');
    const card = read("./FirstRunFluxCard.tsx");
    expect(card).toContain('type="password"');
    expect(card).toContain("saveAndProveFluxKey(key,");
    expect(card).toContain('setKey("")');
    expect(card).not.toMatch(/\{ flux: \{ apiKey|fluxKeyPatch/);
    expect(card).not.toMatch(/value=\{[^}]*apiKey/);
  });
  it("keeps every other first-run surface out of the key business", () => {
    // FluxInvite's other rule: whatever OFFERS the key does not grow a second
    // field for it. There is one field in the first run and the bar has none.
    expect(read("./FirstRunPhases.tsx")).not.toMatch(/<input|type="password"|apiKey/);
    expect(read("./FirstRunCard.tsx")).not.toMatch(/<input|type="password"|apiKey/);
  });
  it("preserves first-run state while Settings temporarily takes focus", () => {
    // Onboarding.tsx had to early-return on `state.appSettingsOpen` so that a
    // trip to Settings for a key did not wipe a half-typed form. The first run
    // is a transcript now, so the rule is kept by there being nothing to lose:
    // no first-run surface is unmounted or reset by a dialog opening, and none
    // of them is conditioned on one.
    for (const file of ["./FirstRunPhases.tsx", "./FirstRunCard.tsx", "./FirstRunFluxCard.tsx", "./FirstRunHelloCard.tsx"]) {
      expect(read(file), file).not.toContain("appSettingsOpen");
    }
    // ...and the screen that needed the guard is gone from the shell for good.
    const app = read("../App.tsx");
    expect(app).not.toMatch(/<Onboarding|<SetupPanel|<FluxInvite/);
  });
});
