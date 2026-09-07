// THE PHONE IS NOT A FRESH DESKTOP.
//
// Observed on a real Android phone, over the tailnet, through the browser
// door: the app served him the DESKTOP's first-run experience. First the
// welcome / email gate — "tell us who you are" — because that gate keys off
// localStorage and a phone is a fresh browser, so it believed he had never
// used Murage while he was holding the device he had paired to it. Then the
// PHONE SETUP wizard, on the phone, whose readiness panel reported "Tailscale
// on this computer: not found" and "Murage in a browser: not listening yet"
// while he was reading it in a browser, over Tailscale — two negatives about
// a machine that renderer cannot see, both disproved by the screen they were
// printed on.
//
// Source contracts, not render tests: the renderer suite runs in a node
// environment with no DOM and these components are 300–1,900 lines each. What
// is worth pinning is not how they look; it is WHICH SIDE each first-run
// screen is allowed to exist on, and that the third state — surface not yet
// known — resolves to the neutral thing every single time. One frame of the
// desktop's welcome screen on a phone is the whole bug.
//
// The one genuinely behavioural piece, the readiness row copy, is a pure
// function and is exercised as one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveDesktopSurface } from "../lib/use-surface";
import { webUiReadinessRows, type WebUiReadiness } from "./PhoneSetupFlow";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const app = read("../App.tsx");
const onboarding = read("./Onboarding.tsx");
const phoneSetup = read("./PhoneSetupFlow.tsx");
const companion = read("./CompanionSection.tsx");
const settings = read("./SettingsPanel.tsx");
const sidebar = read("./Sidebar.tsx");
const hook = read("../lib/use-surface.ts");

/** Every file that suppresses something, so a new one cannot quietly answer
 *  the question a different way. */
const gated: Array<[string, string]> = [
  ["App.tsx", app],
  ["Onboarding.tsx", onboarding],
  ["PhoneSetupFlow.tsx", phoneSetup],
  ["CompanionSection.tsx", companion],
  ["SettingsPanel.tsx", settings],
  ["Sidebar.tsx", sidebar],
];

describe("the surface answer has three states and the third is not 'desktop'", () => {
  it("answers only what it has been told", () => {
    expect(resolveDesktopSurface("desktop", undefined)).toBe(true);
    expect(resolveDesktopSurface("remote", undefined)).toBe(false);
    expect(resolveDesktopSurface(undefined, undefined)).toBeUndefined();
  });

  it("lets the preload bridge answer 'desktop' early, and never 'remote'", () => {
    // Presence of the Electron bridge cannot be manufactured through the
    // browser door — an HTTP response cannot install a preload — so it is a
    // true positive and the packaged desktop's first render is unchanged.
    expect(resolveDesktopSurface(undefined, { platform: "darwin" })).toBe(true);
    // Absence proves nothing: that is also the desktop against Vite.
    expect(resolveDesktopSurface(undefined, null)).toBeUndefined();
    // ...and it OUTRANKS a fetched "remote", which is the case that bit.
    //
    // This assertion was the other way round and it shipped a real bug. The
    // harness began requiring a per-launch secret to prove the desktop, and a
    // renderer served as a production bundle by a harness it did not fork has
    // no way to hold that secret — so the real desktop asked "am I the
    // desktop?", was told no, and hid Connections, Engines, Phone and Local VM
    // from the machine that owns them. A fetch saying "remote" to something
    // holding the preload bridge is a plumbing failure, not a surface.
    expect(resolveDesktopSurface("remote", { platform: "darwin" })).toBe(true);
  });

  it("reads the bridge in one direction only", () => {
    // Presence answers desktop. Absence answers nothing — that is also the
    // desktop against the Vite dev server, which is why the harness is asked
    // at all.
    expect(resolveDesktopSurface(undefined, null)).toBeUndefined();
    expect(resolveDesktopSurface(undefined, undefined)).toBeUndefined();
    expect(resolveDesktopSurface("remote", null)).toBe(false);
    expect(hook).toContain("if (bridge) return true;");
    expect(hook).not.toContain("=== \"remote\" : ");
  });
});

describe("1. the welcome / email gate never reaches a phone", () => {
  it("renders only on a CONFIRMED desktop", () => {
    // Not `!== false`, not `!desktop`. The gate is the desktop thing, so the
    // unknown state must withhold it.
    expect(app).toContain("{desktop === true && gated && <Onboarding onDone={() => setGated(false)} />}");
    expect(app).toContain("const desktop = useDesktopSurface();");
  });

  it("does not decide it from storage alone any more", () => {
    // `emailGateDone()` reads localStorage, and a phone's localStorage is
    // empty however long the person has used Murage. It still gates, but it
    // no longer gates ALONE.
    const gate = app.slice(app.indexOf("const [gated, setGated]"));
    expect(gate).toContain("emailGateDone()");
    expect(app).not.toMatch(/\{gated && <Onboarding/);
  });

  it("takes the ENGINE SCAN and the permission prompt with it", () => {
    // The three screens a paired phone was actually walked through, in order:
    // step 0 the email gate, step 1 "Your engines" — the scan — and step 3 the
    // browser-door wizard. Step 1 polls GET /api/instances for CLIs installed
    // on THIS COMPUTER and offers to install the missing ones; a phone can
    // install nothing, and the door refuses those routes anyway. Step 2 asks
    // macOS for the microphone, which is not this device's microphone.
    //
    // None of them is separately gated, and that is the design: they are steps
    // of ONE screen, and the screen does not exist off the desktop.
    const body = onboarding.slice(onboarding.indexOf("export function Onboarding("));
    const guard = body.indexOf("if (desktop !== true) return null;");
    expect(guard).toBeGreaterThan(-1);
    for (const step of ["{step === 0 && (", "{step === 1 && (", "{step === 2 && (", "{step === 3 && ("]) {
      expect(body.indexOf(step), step).toBeGreaterThan(guard);
    }
    expect(body).toContain("Your engines");
    expect(body).toContain("<PhoneSetupFlow");
  });

  it("is locked a second time in the component itself", () => {
    // So a future caller cannot reopen the hole by mounting <Onboarding>
    // somewhere new.
    expect(onboarding).toContain("if (desktop !== true) return null;");
    expect(onboarding).toContain("const desktop = useDesktopSurface();");
  });
});

describe("2. the phone-setup flow never reaches a phone", () => {
  it("renders nothing once the surface is known to be remote", () => {
    // In the VIEW, ahead of every phase — the intro with its QR promise, the
    // sign-in, the code. Not merely somewhere in the file.
    const view = phoneSetup.slice(phoneSetup.indexOf("export function PhoneSetupFlowView("));
    expect(view).toContain("const desktop = useDesktopSurface();");
    expect(view).toContain("if (desktop === false) return null;");
    expect(view.indexOf("if (desktop === false) return null;"))
      .toBeLessThan(view.indexOf('if (c.phase === "intro")'));
  });

  it("is gone from Settings too, section and all", () => {
    // Hidden, not disabled: a greyed-out wizard for a job this device has
    // already finished is still the wrong screen. Not one switch, not one
    // address, not one pairing button survives — a confirmed remote gets a
    // single sentence, because the nav entry that opens this pane is in a file
    // this lane does not own and a blank pane reads as broken.
    expect(companion).toContain("const desktop = useDesktopSurface();");
    expect(companion).toContain("if (desktop === false) {");
    expect(companion).toContain('title="Phone setup happens on the computer"');
    expect(companion).toContain("if (desktop !== true) return null;");
    // Both decisions come FIRST, ahead of the bridge-missing card that used to
    // be the only remote-ish answer, and ahead of every control below it.
    const body = companion.slice(companion.indexOf("export function CompanionSection("));
    for (const guard of ["if (desktop === false) {", "if (desktop !== true) return null;"]) {
      expect(body.indexOf(guard), guard).toBeLessThan(body.indexOf("if (!companionBridge())"));
    }
    // The sentence is the whole of it: no flow, no switches, no addresses.
    const remote = body.slice(body.indexOf("if (desktop === false) {"), body.indexOf("if (desktop !== true)"));
    for (const forbidden of ["<PhoneSetupFlowView", "<Switch", "<ConnectionDetail", "companion.start()"]) {
      expect(remote, forbidden).not.toContain(forbidden);
    }
  });

  it("takes the sidebar's phone button with it", () => {
    // Its only action is `phoneSettingsAction()`, which opens the section
    // above. A status dot that opens an empty pane is worse than no dot.
    // Both sites — the icon rail and the full-width footer — carry the guard.
    expect(sidebar.match(/desktop === true && \(\n\s*<SidebarPhoneButton/g) ?? []).toHaveLength(2);
    expect(sidebar).toContain('{density === "icons" && desktop === true && (');
    expect(sidebar).toContain('{density !== "icons" && desktop === true && (');
  });
});

describe("3. the readiness panel does not report a negative it cannot see", () => {
  const nothingKnown: WebUiReadiness = {
    ready: false,
    blocker: null,
    tailnetName: null,
    doorAddress: null,
    canRecheck: false,
  };

  it("says 'not found' / 'not listening yet' ONLY on the desktop", () => {
    // The desktop is the one renderer that can look: both facts arrive over
    // the Electron bridge. There, a negative is a finding.
    expect(webUiReadinessRows(nothingKnown, true).map((row) => row.value))
      .toEqual(["not found", "not listening yet"]);
  });

  it("says 'checking…' while it does not know which side it is on", () => {
    // This is the state the bug rendered as two flat denials. Absence of
    // evidence, reported as absence of evidence.
    const rows = webUiReadinessRows(nothingKnown, undefined);
    expect(rows.map((row) => row.value)).toEqual(["checking…", "checking…"]);
    for (const row of rows) {
      expect(row.value).not.toContain("not found");
      expect(row.value).not.toContain("not listening");
      expect(row.good).toBe(false); // still not a claim that anything is fine
    }
  });

  it("still reports what it genuinely found, whichever side it is on", () => {
    const found: WebUiReadiness = {
      ...nothingKnown,
      tailnetName: "seans-mac",
      doorAddress: "seans-mac.tailnet.ts.net:8810",
    };
    for (const desktop of [true, undefined] as const) {
      expect(webUiReadinessRows(found, desktop)).toEqual([
        { label: "Tailscale on this computer", value: "seans-mac", good: true },
        { label: "Murage in a browser", value: "seans-mac.tailnet.ts.net:8810", good: true },
      ]);
    }
  });

  it("does not render at all on a confirmed remote", () => {
    const panel = phoneSetup.slice(phoneSetup.indexOf("function WebUiReadinessPanel("));
    expect(panel.slice(0, panel.indexOf("return ("))).toContain("if (desktop === false) return null;");
  });

  it("has no other source of that copy left", () => {
    // The strings existed once, inline, with no way to say "I did not look".
    expect(phoneSetup).not.toContain('?? "not found"');
    expect(phoneSetup).not.toContain('?? "not listening yet"');
  });
});

describe("4. nothing that installs or executes is offered to a phone", () => {
  it("hides the per-bot Computer / Box / VPS card", () => {
    // "This computer" hands a bot the machine; Cloud opens the backend picker
    // that creates and starts a managed container. The door refuses those
    // routes at the network level, so on a phone they were buttons that 404.
    expect(settings).toContain("{desktop === true && (");
    const card = settings.slice(settings.indexOf("{desktop === true && ("));
    expect(card.slice(0, 400)).toContain('<div className="text-[15px] font-medium text-ink">Computer</div>');
    expect(card).toContain("<CloudBackendPicker");
  });

  it("leaves what a phone IS for alone", () => {
    // Bots, conversations, approvals, skills and library are not gated here.
    expect(settings).toContain("<BotSkillsPanel");
    expect(settings).toContain("<BotUsageCard bot={bot} />");
    expect(settings).not.toContain("desktop === true && (\n          <BotSkillsPanel");
    expect(app).toContain("<ChatView bot={bot} />");
    expect(app).not.toContain("desktop === true && <ChatView");
  });

  it("keeps the engine installer inside the screen that is already gone", () => {
    // <EngineSetup> is reachable from onboarding step 1 and nowhere else in
    // this lane, and onboarding no longer mounts off the desktop. Scoped to
    // the component body: `SetupRow` above it is a helper the guard cannot
    // sit inside, and it is only ever called from the tree below.
    expect(onboarding).toContain("<EngineSetup");
    const body = onboarding.slice(onboarding.indexOf("export function Onboarding("));
    expect(body).toContain("if (desktop !== true) return null;");
    expect(body).toContain("<SetupRow key={e.label}");
    expect(body.indexOf("if (desktop !== true) return null;"))
      .toBeLessThan(body.indexOf("<SetupRow key={e.label}"));
  });
});

describe("5. the desktop is untouched", () => {
  it("suppresses by not rendering, never by rendering something else", () => {
    // Every gate is a plain guard with no `else`. With the answer `true` each
    // file's tree is exactly the tree it had before, so "unchanged on the
    // desktop" is a property of the shape, not of a screenshot.
    for (const [name, source] of gated) {
      expect(source, name).not.toMatch(/desktop === true \? /);
      expect(source, name).not.toMatch(/desktop === false \? /);
      expect(source, name).not.toMatch(/desktop \?/);
    }
  });

  it("never treats 'not known yet' as 'desktop'", () => {
    for (const [name, source] of gated) {
      expect(source, name).not.toContain("desktop !== false");
      expect(source, name).not.toContain("desktop === undefined ? true");
      expect(source, name).not.toContain("desktop ?? true");
    }
  });

  it("asks the same seam every other surface-aware screen asks", () => {
    for (const [name, source] of gated) {
      expect(source, name).toContain("useDesktopSurface");
    }
    expect(hook).toContain('from "./surface"');
    // and does not re-implement the fetch, the caching, or the secret
    for (const [name, source] of gated) {
      expect(source, name).not.toContain('fetch("/api/config", { headers: { "x-murage-surface"');
    }
  });
});
