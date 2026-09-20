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
const rail = read("./FirstRunRail.tsx");
const firstRun = read("../lib/first-run.ts");
const phoneSetup = read("./PhoneSetupFlow.tsx");
const companion = read("./CompanionSection.tsx");
const settings = read("./SettingsPanel.tsx");
const sidebar = read("./Sidebar.tsx");
const hook = read("../lib/use-surface.ts");

/** 0.1.58 folded the welcome screen into the Chief of Staff's thread, and the
 *  only first-run CHROME left is the progress rail. The gate that replaced
 *  <Onboarding>'s early return is App.tsx's, and this is it. `desktop === true`
 *  and not `!== false`: the unknown surface is refused, which was the bug. */
const RAIL_GATE = "{desktop === true && <FirstRunRail />}";

/** Every file that suppresses something, so a new one cannot quietly answer
 *  the question a different way. */
const gated: Array<[string, string]> = [
  ["App.tsx", app],
  ["FirstRunRail.tsx", rail],
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
    expect(app).toContain(RAIL_GATE);
    expect(app).toContain("const desktop = useDesktopSurface();");
  });

  it("does not decide it from storage at all any more", () => {
    // THE ORIGINAL BUG, now closed at the root rather than patched.
    //
    // `emailGateDone()` read localStorage, and a phone's localStorage is
    // empty however long the person has used Murage, so the client's own
    // answer to "is this a new install" was wrong on the one surface where
    // being wrong mattered. The client no longer HAS an answer: the server
    // derives `firstRun` from the workspace itself (setupIsFirstRun,
    // shared/setup.ts), and every first-run surface reads that. A phone's
    // empty storage cannot reach a fact measured on the machine.
    // Code only: the comment above the gate still tells the story of the bug,
    // and the story is worth keeping. What must be gone is the call.
    const appCode = app.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(appCode).not.toContain("emailGateDone");
    expect(appCode).not.toContain("<Onboarding");
    expect(firstRun).not.toContain("localStorage");
    expect(firstRun).toContain("view.firstRun");
  });

  it("is locked a second time inside the rail itself", () => {
    // So a future caller cannot reopen the hole by mounting the rail
    // somewhere new. It renders nothing unless the server's own view says
    // this install is in its first run, and it holds no opinion of its own
    // about what a new install looks like.
    expect(rail).toContain("const desktop = useDesktopSurface();");
    expect(rail).toContain("if (desktop !== true || !view || !firstRunRailVisible(view, rail)) return null;");
    expect(rail).not.toContain("localStorage");
  });

  // REMOVED WITH THE SCREEN IT GUARDED.
  //
  // This used to pin that the engine scan and the workspace check lived
  // inside <Onboarding>'s one early return, because they were steps of one
  // screen and the screen did not exist off the desktop. 0.1.58 deleted that
  // screen. The engine scan is not a step any more, it is detection that
  // runs before anyone is asked anything, and the workspace check is now the
  // server's `firstRun`. The rule those assertions protected is covered
  // above, twice: App.tsx's gate and the rail's own.
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

  it("no longer offers to install an engine on a first-run screen at all", () => {
    // <EngineSetup> polled GET /api/instances for CLIs on THIS computer and
    // offered to install the missing ones, from inside the welcome screen a
    // phone was being shown. That screen is gone, and the first run does not
    // ask the question any more: what is installed is DETECTED before
    // anybody is asked anything, and the agents card reports the answer.
    // So the rule is stronger than a guard. There is nothing to guard.
    expect(rail).not.toContain("<EngineSetup");
    for (const file of ["./FirstRunCard.tsx", "./FirstRunHelloCard.tsx", "./FirstRunChrome.tsx"]) {
      expect.soft(read(file), `${file} mounts the engine installer`).not.toContain("<EngineSetup");
    }
  });
});

describe("5. the desktop is untouched", () => {
  it("suppresses by not rendering, never by rendering something else", () => {
    // Every gate is a plain guard with no `else`. With the answer `true` each
    // file's tree is exactly the tree it had before, so "unchanged on the
    // desktop" is a property of the shape, not of a screenshot.
    //
    // A menu built from an items ARRAY cannot use `&&` — a `false` entry is
    // not an item — so the sidebar's desktop-only Files entry (c95571f0) is
    // spread from an EMPTY list off the desktop:
    // `...(desktop === true ? [item] : [])`. Nothing is rendered in its
    // place, which is the same rule in the only shape an array admits. That
    // exact form is the only ternary allowed; an `else` that renders
    // something, or a `desktop === false` / `desktop ?` branch, is still a
    // leak.
    const EMPTY_LIST_SPREAD = /\.\.\.\(desktop === true \? \[[^\]]*\] : \[\]\)/g;
    // Files. Approvals and Inbox left the Tools menu in 0.1.57 for the
    // sidebar's own "Needs you" row, which is an ordinary `desktop === true
    // &&` guard and needs no exception here.
    expect(sidebar.match(EMPTY_LIST_SPREAD)).toHaveLength(1);
    // A prop could have the same non-rendering shape: `={desktop === true ?
    // value : undefined}` passes nothing off the desktop. No sidebar prop
    // uses it today; the pattern stays pinned so re-introducing one has to be
    // reviewed here.
    const UNDEFINED_PROP = /=\{desktop === true \? [^?:{}]+ : undefined\}/g;
    expect(sidebar.match(UNDEFINED_PROP)).toBeNull();
    for (const [name, source] of gated) {
      const withoutEmptySpreads = source.replace(EMPTY_LIST_SPREAD, "").replace(source === sidebar ? UNDEFINED_PROP : /$^/g, "");
      expect(withoutEmptySpreads, name).not.toMatch(/desktop === true \? /);
      expect(withoutEmptySpreads, name).not.toMatch(/desktop === false \? /);
      expect(withoutEmptySpreads, name).not.toMatch(/desktop \?/);
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
