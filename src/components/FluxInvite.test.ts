// The offer. What it says, and the ways it must not behave.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false,
  setAnalyticsEnabled: () => {},
  initAnalytics: () => {},
  track: () => {},
}));

const { FluxInviteBody } = await import("./FluxInvite");

const source = readFileSync(fileURLToPath(new URL("./FluxInvite.tsx", import.meta.url)), "utf8");
const render = () =>
  renderToStaticMarkup(createElement(FluxInviteBody, { onOpen: vi.fn(), onDismiss: vi.fn() }));

describe("the invitation is an offer, not a gate", () => {
  it("covers nothing and traps no focus", () => {
    const html = render();
    // A full-viewport backdrop or a modal dialog would make a key something a
    // person has to deal with before using an app that already works without
    // one. Neither is allowed here.
    expect(html).not.toContain("inset-0");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("aria-modal");
    expect(html).toContain('role="complementary"');
  });

  it("sits in a corner rather than across the app", () => {
    const html = render();
    expect(html).toContain("fixed bottom-4 right-4");
    // POSITIVE control: the same assertion notices when a class is absent, so
    // the check above is reading markup rather than agreeing with anything.
    expect(html).not.toContain("fixed inset-x-0 top-0");
  });

  it("can always be refused, by the corner X and by a named button", () => {
    const html = render();
    expect(html).toContain('aria-label="Not now"');
    expect(html).toContain(">Not now</button>");
  });

  it("points at the one key field instead of carrying its own", () => {
    const html = render();
    expect(html).toContain(">Add a key</button>");
    expect(html).not.toContain("<input");
    expect(source).toContain('dispatch({ type: "toggleAppSettings", open: true, section: "connections" })');
  });

  it("is over once it has been acted on, either way", () => {
    // Opening Settings dismisses too: the person has been shown the door, so
    // the corner card has done its job and must not return next launch.
    expect(source).toMatch(/onOpen=\{\(\) => \{\s*dismiss\(\);/);
    expect(source).toMatch(/onDismiss=\{dismiss\}/);
  });
});

describe("what it says", () => {
  it("leads with what the person gets", () => {
    const html = render();
    expect(html).toContain("Let your bots pick the right model");
  });

  it("says out loud that the app already works without it", () => {
    expect(render()).toContain("Murage is already fine without it.");
  });

  it("answers the question a key always provokes, before it is asked", () => {
    // "Does this replace my Claude subscription?" It does not: engines stay
    // separately authenticated and a Flux row is one more thing a bot can be
    // pointed at. Saying so inline is cheaper than the person stalling.
    expect(render()).toContain("Your CLI logins keep working");
  });

  it("carries no em dash", () => {
    expect(render()).not.toContain("—");
    // POSITIVE control: prove this assertion can fail.
    expect(() => expect("a — dash").not.toContain("—")).toThrow();
  });
});

describe("when it appears", () => {
  it("leaves every rule in the pure decision, not in the JSX", () => {
    // A decision inside a .tsx is a decision no test can execute. The only
    // conditional here is the one line that reads the decision's answer.
    expect(source).toContain("const { visible, dismiss } = useFluxInvite(firstRunGate);");
    expect(source).toContain("if (!visible) return null;");
    // and the component must not re-derive any of the facts itself
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("useDesktopSurface");
  });

  it("takes the first-run gate as a prop so the mount stays one line", () => {
    expect(source).toMatch(/export function FluxInvite\(\{ firstRunGate \}: \{ firstRunGate: boolean \}\)/);
  });
});
