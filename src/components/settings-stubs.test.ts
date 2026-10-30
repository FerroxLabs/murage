// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-UX-1011 S1: a Settings card or a bot settings section never silently renders nothing because a feature is off or
// unavailable. Each gated card is rendered in its on and off states, and an invariant holds that no gated card component
// returns null for a gated state.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailStatusView } from "../../shared/email-copy.ts";
import type { EmailStatusState } from "@/lib/bot-email";

const fixture = vi.hoisted(() => ({
  config: { flux: { configured: false } } as Record<string, unknown> | null,
  bots: [{ id: "nova", name: "Nova", chiefOfStaff: true, chiefScope: "workspace" }] as Array<Record<string, unknown>>,
  dispatch: vi.fn(),
  desktop: true as boolean | undefined,
  email: { kind: "off" } as EmailStatusState,
}));

vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state: { config: fixture.config, bots: fixture.bots, botSettingsIntent: null }, dispatch: fixture.dispatch }),
  api: vi.fn(async () => { throw new Error("no network in this test"); }),
}));
vi.mock("@/lib/use-surface", async (original) => ({
  ...(await original<typeof import("@/lib/use-surface")>()),
  useDesktopSurface: () => fixture.desktop,
}));
vi.mock("@/lib/bot-email", async (original) => ({
  ...(await original<typeof import("@/lib/bot-email")>()),
  useEmailStatus: () => fixture.email,
}));
vi.mock("./SettingsPanel", () => ({ SettingsPanel: () => null }));
vi.mock("@/lib/learning-counts", async (original) => ({
  ...(await original<typeof import("@/lib/learning-counts")>()),
  useLearningBadge: () => 0,
}));

const { BotEmailAccountCard, BotEmailSection, BotEmailStub, emailGate } = await import("./BotEmailSettings");
const { ComputerOnlyStub, SETTINGS_STUB_COPY, SettingsStub, chiefName, settingsCardPath } = await import("./SettingsStub");
const { WorkspaceFeatureRow } = await import("./SettingsModal");
const { BotSettingsDialog } = await import("./BotSettingsDialog");
const { CLOUD_COMPUTER_ONLY_CARDS } = await import("@/lib/cloud-settings");
const { CLOUD_PROTOCOL } = await import("@/lib/cloud-workspace");
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

const ON_VIEW = { enabled: true, accountState: "active", ownerSignedIn: true, termsVersion: null, removing: [], otherSetups: [] } as unknown as EmailStatusView;
const bot = { id: "nova", name: "Nova", threadId: "t1" };
const render = (type: unknown, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(type as never, props as never));
/** Text as renderToStaticMarkup writes it. */
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;");
/** Every gated state the email reader can answer, with the stub line each one must show. */
const EMAIL_OFF_STATES: Array<[string, EmailStatusState, boolean | null, string]> = [
  ["still checking", { kind: "loading" }, false, SETTINGS_STUB_COPY.checking(SETTINGS_STUB_COPY.botEmail)],
  ["dark launch with Flux connected", { kind: "off" }, true, SETTINGS_STUB_COPY.notYet],
  ["no Flux Router account", { kind: "off" }, false, SETTINGS_STUB_COPY.needsAccount("Nova")],
  ["lost its Flux key (section 8): the server's own line", { kind: "flux-off", line: "Email addresses for bots come with Flux. Connect Flux in Settings to use them." }, false, "Email addresses for bots come with Flux. Connect Flux in Settings to use them."],
  ["the read failed (5xx or network)", { kind: "error" }, true, SETTINGS_STUB_COPY.couldNotCheck(SETTINGS_STUB_COPY.botEmail)],
  ["Flux answered 401 on the saved key (1.0.11)", { kind: "flux-refused", line: "Your Flux key stopped working. Sign in with Flux again." }, true, "Your Flux key stopped working. Sign in with Flux again."],
  ["settings not loaded yet", { kind: "off" }, null, SETTINGS_STUB_COPY.checking(SETTINGS_STUB_COPY.botEmail)],
];

beforeEach(() => {
  fixture.config = { flux: { configured: false } };
  fixture.desktop = true;
  fixture.email = { kind: "off" };
  fixture.dispatch.mockReset();
  vi.stubGlobal("window", { muragebox: { browser: {} }, confirm: () => true });
});
afterEach(() => vi.unstubAllGlobals());

const setFlux = (flux: boolean | null) => { fixture.config = flux === null ? null : { flux: { configured: flux } }; };

describe("the six state lines (section 5 final copy)", () => {
  it("say why and the next step, with no em dash", () => {
    const lines = [
      SETTINGS_STUB_COPY.off("use a browser tab"), SETTINGS_STUB_COPY.needsAccount("Nova"), SETTINGS_STUB_COPY.notYet,
      SETTINGS_STUB_COPY.otherSurface("General > Advanced > Start at login"), SETTINGS_STUB_COPY.needsEngine("Codex", "Nova"), SETTINGS_STUB_COPY.coming("1.0.12"),
    ];
    expect(lines).toEqual([
      "Off. Turn it on to let bots use a browser tab.",
      "Needs a Flux Router account with email on. Ask Nova to set it up, or open Flux Router.",
      "Not on for your account yet. We are turning it on in stages.",
      "Set this on your computer. Open Murage on the desktop, then Settings > General > Advanced > Start at login.",
      "Codex cannot do this yet. Pick an engine that can under Model, or ask Nova.",
      "Coming in 1.0.12.",
    ]);
    for (const line of lines) expect(line).not.toMatch(/—|Unavailable|Disabled|Not supported/);
  });

  it("name the workspace Chief, or a plain fallback", () => {
    expect(chiefName(fixture.bots as never)).toBe("Nova");
    expect(chiefName([{ name: "Pip" }] as never)).toBe("your Chief");
    expect(chiefName(undefined)).toBe("your Chief");
  });

  it("render dimmed, never as an alert or an error", () => {
    const html = render(SettingsStub, { title: "Bot email", state: "not-yet", line: SETTINGS_STUB_COPY.notYet });
    expect(html).toContain("Bot email");
    expect(html).toContain('data-settings-stub="not-yet"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/text-danger|text-warning/);
  });
});

describe("Settings > Connected apps > Bot email card", () => {
  it.each(EMAIL_OFF_STATES)("off (%s): the card renders its title and the stub line", (_name, status, flux, line) => {
    setFlux(flux);
    const html = render(BotEmailAccountCard, { status });
    expect(html).toContain("Bot email");
    expect(html).toContain(esc(line));
    expect(html).toContain('data-testid="bot-email-account-stub"');
    expect(html).not.toContain('data-testid="bot-email-account"');
  });

  it("needs an account: on the desktop the stub opens Models & engines", () => {
    let html = render(BotEmailAccountCard, { status: { kind: "off" } });
    expect(html).toContain(esc(SETTINGS_STUB_COPY.openModels));
    fixture.desktop = false;
    html = render(BotEmailAccountCard, { status: { kind: "off" } });
    expect(html).not.toContain(esc(SETTINGS_STUB_COPY.openModels));
    expect(html).toContain(esc(SETTINGS_STUB_COPY.needsAccount("Nova")));
  });

  it("a saved Flux key that Flux refused is still a missing account, never \"not on for your account yet\"", () => {
    fixture.config = { flux: { configured: true, keyState: "refused" } };
    const html = render(BotEmailAccountCard, { status: { kind: "off" } });
    expect(html).toContain(esc(SETTINGS_STUB_COPY.needsAccount("Nova")));
    expect(html).not.toContain(esc(SETTINGS_STUB_COPY.notYet));
  });

  describe("the saved Flux key stopped working (probe 401, 1.0.11)", () => {
    const refused: EmailStatusState = { kind: "flux-refused", line: "Your Flux key stopped working. Sign in with Flux again." };
    const withBridge = () => vi.stubGlobal("window", { muragebox: { browser: {}, fluxSignin: { start: async () => ({ ok: true }), cancel: async () => {} } }, confirm: () => true });
    it("the card stays, says so and offers Sign in with Flux (the Models & engines flow), in the card and the bot's section", () => {
      withBridge(); setFlux(true);
      for (const html of [render(BotEmailAccountCard, { status: refused }), render(BotEmailSection, { bot, status: refused })]) {
        expect(html).toContain("Bot email");
        expect(html).toContain(esc("Your Flux key stopped working. Sign in with Flux again."));
        expect(html).toMatch(/<button[^>]*>Sign in with Flux<\/button>/);
        expect(html).not.toContain(esc(SETTINGS_STUB_COPY.notYet));
        expect(html).not.toContain(esc(SETTINGS_STUB_COPY.openModels));
      }
      expect(emailGate(refused, true)).toBe("key-refused");
      expect(emailGate(refused, false)).toBe("key-refused");
    });
    it("no Flux account yet (needs-account): the Bot email row is a real Sign in with Flux too, with the switch unset (default on)", () => {
      withBridge(); setFlux(false);
      const html = render(BotEmailAccountCard, { status: { kind: "off" } });
      expect(html).toContain(esc(SETTINGS_STUB_COPY.needsAccount("Nova")));
      expect(html).toMatch(/<button[^>]*>Sign in with Flux<\/button>/);
      expect(render(BotEmailSection, { bot, status: { kind: "off" } })).toMatch(/<button[^>]*>Sign in with Flux<\/button>/);
    });
    it("Models & engines offers the same Sign in with Flux whenever the switch is unset (default on) and the shell has the bridge", async () => {
      const { fluxDesktopSigninEnabled } = await import("@/lib/feature-flags");
      for (const config of [{}, { features: {} }, { flux: { configured: true } }]) expect(fluxDesktopSigninEnabled(config)).toBe(true);
      expect(fluxDesktopSigninEnabled({ features: { fluxDesktopSignin: false } })).toBe(false);
      const models = source("ModelsSettings.tsx");
      expect(models).toContain("onSignin={fluxDesktopSigninEnabled(state.config) && window.muragebox?.fluxSignin ? async () => {");
      expect(models).toContain("window.muragebox!.fluxSignin!.start({ action: flux.configured ? \"replace\" : \"connect\", revision: flux.revision })");
      const { FluxRouterConnection } = await import("./FluxRouterConnection");
      const row = render(FluxRouterConnection, { configured: false, onSave: async () => {}, onSignin: async () => {}, onCancelSignin: () => {}, onSelect: async () => {}, onTest: async () => ({ modelCount: 0 }), onDisconnect: async () => {} });
      expect(row).toContain("Sign in with Flux Router");
    });
    it("explicit fluxDesktopSignin = false, or no sign-in bridge: Open Models & engines instead; phone and Cloud window: the line only", () => {
      withBridge();
      fixture.config = { flux: { configured: true }, features: { fluxDesktopSignin: false } };
      let html = render(BotEmailAccountCard, { status: refused });
      expect(html).toContain(esc(SETTINGS_STUB_COPY.openModels));
      expect(html).not.toMatch(/>Sign in with Flux</);
      setFlux(true);
      vi.stubGlobal("window", { muragebox: { browser: {} }, confirm: () => true });
      html = render(BotEmailAccountCard, { status: refused });
      expect(html).toContain(esc(SETTINGS_STUB_COPY.openModels));
      withBridge(); fixture.desktop = false;
      html = render(BotEmailAccountCard, { status: refused });
      expect(html).toContain(esc("Your Flux key stopped working. Sign in with Flux again."));
      expect(html).not.toContain("<button");
      fixture.desktop = true;
      vi.stubGlobal("location", { protocol: CLOUD_PROTOCOL });
      expect(render(BotEmailAccountCard, { status: refused })).not.toContain("<button");
    });
  });

  it("the Cloud window cannot set Flux, so it gets no Open Models & engines button", () => {
    vi.stubGlobal("location", { protocol: CLOUD_PROTOCOL });
    const html = render(BotEmailAccountCard, { status: { kind: "off" } });
    expect(html).toContain(esc(SETTINGS_STUB_COPY.needsAccount("Nova")));
    expect(html).not.toContain(esc(SETTINGS_STUB_COPY.openModels));
  });

  it("not on for the account yet: no button, the line ends the hunt", () => {
    setFlux(true);
    expect(render(BotEmailAccountCard, { status: { kind: "off" } })).not.toContain("<button");
  });

  it("on: the real card with its switch, no stub", () => {
    const html = render(BotEmailAccountCard, { status: { kind: "on", view: ON_VIEW } });
    expect(html).toContain('data-testid="bot-email-account"');
    expect(html).toContain('role="switch"');
    expect(html).not.toContain("data-settings-stub");
  });

  it("maps every reader state to a gate, and only on to none", () => {
    expect(emailGate({ kind: "on", view: ON_VIEW }, true)).toBeNull();
    expect(emailGate({ kind: "loading" }, true)).toBe("checking");
    expect(emailGate({ kind: "off" }, true)).toBe("not-yet");
    expect(emailGate({ kind: "off" }, false)).toBe("needs-account");
    expect(emailGate({ kind: "off" }, undefined)).toBe("checking");
    expect(emailGate({ kind: "flux-off", line: "x" }, true)).toBe("needs-account");
    expect(emailGate({ kind: "error" }, true)).toBe("could-not-check");
  });
});

describe("Bot settings > Email section", () => {
  it.each(EMAIL_OFF_STATES)("off (%s): the section body renders the stub", (_name, status, flux, line) => {
    setFlux(flux);
    const html = render(BotEmailSection, { bot, status });
    expect(html).toContain("Bot email");
    expect(html).toContain(esc(line));
    expect(html).toContain('data-testid="bot-email-section-stub"');
  });

  it("on, before the bot's own email is read: a reading line, not a blank", () => {
    const html = render(BotEmailSection, { bot, status: { kind: "on", view: ON_VIEW } });
    expect(html).toContain('data-settings-stub="checking"');
    expect(html).toContain(esc(SETTINGS_STUB_COPY.readingBot("Nova")));
  });

  it("on, and the bot's own email read failed: says so, never a checking line forever", async () => {
    const { readBotEmail } = await import("@/lib/bot-email");
    expect(await readBotEmail("nova", async () => { throw new Error("down"); })).toBeNull();
    // the failed branch is a stub with its own line (the effect cannot run in a static render, so its copy is checked here)
    expect(SETTINGS_STUB_COPY.couldNotRead("Nova")).toBe("Could not read Nova's email just now. Open another section and come back to try again.");
    expect(source("BotEmailSettings.tsx")).toMatch(/readFailed\s*\n?\s*\? <SettingsStub[^>]*state="could-not-check"[^>]*couldNotRead\(bot\.name\)/);
  });

  it("the Email row is always listed, marked Off while email is off, and unmarked while on", () => {
    fixture.email = { kind: "off" };
    let html = render(BotSettingsDialog, { bot: { id: "nova", name: "Nova" } });
    expect(html).toContain(">Email<");
    expect(html).toContain('data-gated-row="email"');
    expect(html).toContain('<option value="email">Email (Off)</option>');
    fixture.email = { kind: "error" };
    html = render(BotSettingsDialog, { bot: { id: "nova", name: "Nova" } });
    expect(html).not.toContain("data-gated-row");
    fixture.email = { kind: "on", view: ON_VIEW };
    html = render(BotSettingsDialog, { bot: { id: "nova", name: "Nova" } });
    expect(html).toContain(">Email<");
    expect(html).not.toContain("data-gated-row");
    fixture.email = { kind: "loading" };
    html = render(BotSettingsDialog, { bot: { id: "nova", name: "Nova" } });
    expect(html).toContain(">Email<");
    expect(html).not.toContain("data-gated-row");
  });
});

describe("cards that need this computer, in the Cloud window", () => {
  it.each([...CLOUD_COMPUTER_ONLY_CARDS])("%s renders its title, where to set it, and a copy of the path", (anchor) => {
    const found = settingsCardPath(anchor);
    expect(found, anchor).not.toBeNull();
    const html = render(ComputerOnlyStub, { anchor });
    expect(html).toContain(esc(found!.title));
    expect(html).toContain(esc(SETTINGS_STUB_COPY.otherSurface(found!.path)));
    expect(html).toContain(SETTINGS_STUB_COPY.copyPath);
    expect(html).toContain('data-settings-stub="other-surface"');
  });

  it("paths name the page and the fold", () => {
    expect(settingsCardPath("startup-heading")?.path).toBe("General > Advanced > Start at login and run in the background");
    expect(settingsCardPath("setup-heading")?.path).toBe("About & updates > Run setup again");
  });
});

describe.each([
  ["browser", "use a browser tab you can watch and take over"],
  ["skillRecorder", "learn a skill from a recording or /learn"],
] as const)("%s workspace switch", (feature, letsBots) => {
  it("off: one Off line beside the switch", () => {
    fixture.config = { features: { [feature]: false } };
    const html = render(WorkspaceFeatureRow, { feature });
    expect(html).toContain(esc(SETTINGS_STUB_COPY.off(letsBots)));
    expect(html).toContain('aria-checked="false"');
  });

  it("on: no Off line", () => {
    fixture.config = { features: { [feature]: true } };
    expect(render(WorkspaceFeatureRow, { feature })).not.toContain("data-settings-stub");
  });
});

describe("invariant: no gated card component returns null for a gated state", () => {
  /** The body of `export function name(` up to the next top-level function. */
  const body = (text: string, name: string) => {
    const start = text.indexOf(`export function ${name}(`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start + 1);
    const end = rest.search(/\n(?:export )?(?:async )?function /);
    return end < 0 ? rest : rest.slice(0, end);
  };

  it.each([
    ["BotEmailSettings.tsx", "BotEmailAccountCard"],
    ["BotEmailSettings.tsx", "BotEmailSection"],
    ["BotEmailSettings.tsx", "BotEmailStub"],
    ["BotEmailSettings.tsx", "BotEmailSectionHost"],
    ["SettingsStub.tsx", "SettingsStub"],
    ["SettingsStub.tsx", "ComputerOnlyStub"],
    ["SettingsModal.tsx", "WorkspaceFeatureRow"],
  ])("%s %s has no return null", (file, name) => {
    expect(body(source(file), name)).not.toMatch(/return null\b/);
  });

  it("every email gate state renders markup with a title and a line, in the card and in the section", () => {
    for (const [, status, flux] of EMAIL_OFF_STATES) {
      setFlux(flux);
      for (const html of [render(BotEmailAccountCard, { status }), render(BotEmailSection, { bot, status }), render(BotEmailStub, { status, testId: "x" })]) {
        expect(html).toContain("Bot email");
        expect(html).toMatch(/data-settings-stub="(?:checking|could-not-check|needs-account|not-yet)"/);
      }
    }
  });

  it("Settings never hides a card on a Cloud gate, and the bot window never filters a gated row out", () => {
    expect(source("SettingsModal.tsx")).not.toContain("!cloudCardHidden(");
    const dialog = source("BotSettingsDialog.tsx");
    const matches = dialog.slice(dialog.indexOf("const matches = "), dialog.indexOf("\n", dialog.indexOf("const matches = ")));
    expect(matches).not.toContain("GATED_BOT_SETTINGS");
    expect(dialog).not.toMatch(/!GATED_BOT_SETTINGS\.has/);
  });

  it("a stub's line is never an alert", () => {
    const stub = source("SettingsStub.tsx").replace(/^\s*\/\/.*$/gm, "");
    expect(stub).not.toContain('role="alert"');
    expect(stub).not.toMatch(/text-danger|text-warning/);
  });
});

