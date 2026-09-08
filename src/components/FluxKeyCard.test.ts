// The Flux key field. What it must never render, and what it must.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// desktop.ts reads `window` at module scope and @/lib/analytics boots
// posthog-js on import; neither survives a node-env import of the component.
Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false,
  setAnalyticsEnabled: () => {},
  initAnalytics: () => {},
  track: () => {},
}));

const { FluxKeyCardBody } = await import("./FluxKeyCard");
type Props = Parameters<typeof FluxKeyCardBody>[0];

const render = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(
    createElement(FluxKeyCardBody, {
      configured: false,
      value: "",
      onValue: vi.fn(),
      onSave: vi.fn(),
      saving: false,
      error: null,
      ...over,
    }),
  );

const source = readFileSync(fileURLToPath(new URL("./FluxKeyCard.tsx", import.meta.url)), "utf8");

describe("the key is never shown in full", () => {
  it("masks what is being typed", () => {
    const html = render({ value: "flux-live-verysecret" });
    expect(html).toContain('type="password"');
    expect(html).not.toContain('type="text"');
  });

  it("has no way to read a saved key back out of config", () => {
    // GET /api/config answers `flux: { configured: boolean }` and ConfigStatus
    // is typed to match, so there is no field a key could arrive in. This
    // asserts the component never reaches for one anyway.
    expect(source).toMatch(/state\.config\?\.flux\?\.configured/);
    expect(source).not.toMatch(/config[^\n]*\.flux[^\n]*apiKey/);
    // apiKey appears in exactly one place: the outbound patch builder.
    expect(source.match(/apiKey/g) ?? []).toHaveLength(0);
    expect(source).toContain("fluxKeyPatch(value.trim())");
  });

  it("shows a connected key as a flag, not as a value", () => {
    const html = render({ configured: true });
    expect(html).toContain("Connected");
    expect(html).toContain("Saved. Paste a new key to replace it.");
    // POSITIVE control: the same rig does NOT report Connected when there is
    // no key, so a green above is the flag working and not the matcher
    // agreeing with everything.
    expect(render({ configured: false })).not.toContain("Connected");
  });

  it("drops the typed key the moment it is saved", () => {
    expect(source).toMatch(/setValue\(""\)/);
  });
});

describe("what the field offers", () => {
  it("saves through the config route, the door that works on both surfaces", () => {
    expect(source).toMatch(/api\("\/api\/config", \{ method: "PUT", body: fluxKeyPatch/);
  });

  it("cannot be saved empty when there is nothing to clear", () => {
    // Nothing typed and no key saved: the button is inert rather than posting
    // an empty patch the server would answer 400 to.
    expect(render({ configured: false, value: "" })).toContain("disabled=");
    // POSITIVE control: it does become live once there is something to send.
    expect(render({ configured: false, value: "flux-live-abc" })).not.toContain("disabled=");
  });

  it("offers to clear a saved key by leaving the box empty", () => {
    const html = render({ configured: true, value: "" });
    expect(html).toContain("Clear");
    expect(html).toContain("Remove the saved key");
  });

  it("surfaces a save failure instead of swallowing it", () => {
    expect(render({ error: "nothing to save" })).toContain("nothing to save");
    expect(render({ error: null })).not.toContain("nothing to save");
  });

  it("is labelled for a screen reader and points at where to get a key", () => {
    const html = render();
    expect(html).toContain('aria-label="Flux Router key"');
    expect(html).toContain("https://fluxrouter.ai");
  });
});

describe("Flux setup is reachable without duplicating the invitation field", () => {
  it("Settings renders Models with the existing Flux key control", () => {
    const settings = readFileSync(fileURLToPath(new URL("./SettingsModal.tsx", import.meta.url)), "utf8");
    expect(settings).toContain('<ModelsSettings />');
    const models = readFileSync(fileURLToPath(new URL("./ModelsSettings.tsx", import.meta.url)), "utf8");
    expect(models).toContain('<ExistingKey id="legacy-flux" label="Flux Router default"');
    expect(models).toContain('configured={state.config?.flux?.configured ?? false}');
  });

  it("is reachable by searching Settings for flux", () => {
    const settings = readFileSync(fileURLToPath(new URL("./SettingsModal.tsx", import.meta.url)), "utf8");
    const models = settings.match(/\{ id: "models",[^\n]*\}/)?.[0] ?? "";
    expect(models).toContain('"Models"');
    expect(models).toContain('"flux"');
  });

  it("does not grow a second one inside the invitation", () => {
    const invite = readFileSync(fileURLToPath(new URL("./FluxInvite.tsx", import.meta.url)), "utf8");
    expect(invite).not.toMatch(/<input/);
    expect(invite).not.toContain("fluxKeyPatch");
  });
});
