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
  it("routes the invitation and avatar hint to Models", () => {
    for (const file of ["./FluxInvite.tsx", "./BotProfileAvatarCard.tsx"]) expect(read(file)).toContain('section: "models"');
    expect(read("./FluxInvite.tsx")).not.toMatch(/<input/);
  });
  it("preserves onboarding state while Settings temporarily takes focus", () => {
    const source = read("./Onboarding.tsx");
    expect(source).toContain('workspace === "established" || state.appSettingsOpen) return null;');
    expect(source.indexOf('state.appSettingsOpen) return null;')).toBeGreaterThan(source.lastIndexOf('useEffect('));
  });
});
