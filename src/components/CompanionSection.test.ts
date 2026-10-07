import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CompanionAccountState } from "../types/muragebox";
import { en } from "@/locales";
import {
  companionStateRefreshIsCurrent,
  mutateCompanionBridgeState,
  type CompanionState,
} from "./PhoneSetupFlow";
import {
  companionAccountActionError,
  companionPairingMode,
  deriveCompanionPanelStatus,
  loadCompanionBridgeState,
  remoteAccessSummary,
  shouldHydrateCompanionEmail,
  tailscaleAccountLine,
  COMPANION_PAGE_TITLE,
  SIGN_IN_CARD_TITLE,
  TURN_ON_LABEL,
  TURN_ON_SUBTITLE,
  shouldOpenCodeAfterTurnOn,
  turnOffPhoneAccess,
  turnOnForCode,
  turnOnPhoneAccess,
  RevokeDeviceConfirm,
} from "./CompanionSection";

const account = (status: CompanionAccountState["status"], message?: string): CompanionAccountState => ({
  available: true,
  status,
  message,
});

describe("companion account action errors", () => {
  it("shows retry and sign-out failures while the account remains signed in", () => {
    expect(companionAccountActionError(account("ready"), "Sign out could not finish")).toBe(
      "Sign out could not finish",
    );
    expect(companionAccountActionError(account("error"), "Retry could not finish")).toBe(
      "Retry could not finish",
    );
  });

  it("uses account messages only as the signed-out fallback", () => {
    expect(companionAccountActionError(account("signed-out", "Enter a valid email"), null)).toBe(
      "Enter a valid email",
    );
    expect(companionAccountActionError(account("error", "Secure connection needs attention"), null)).toBeNull();
  });
});

describe("companion status refresh", () => {
  it("omits the redundant status pill when phone access is ready for its first pairing", () => {
    expect(deriveCompanionPanelStatus({
      enabled: true,
      devices: [],
    })).toBeNull();
  });

  it("does not show a healthy status when the enabled sidecar reports an error", () => {
    expect(deriveCompanionPanelStatus({
      enabled: true,
      devices: [],
      error: "sidecar stopped responding",
    })).toEqual({ label: "Phone access needs attention", good: false });
  });

  it("keeps account refreshes when the local Companion status fails", async () => {
    const remoteAccount = account("signed-out", "Email a code");
    const refreshed = await loadCompanionBridgeState(
      { state: () => Promise.reject(new Error("sidecar unavailable")) },
      { state: () => Promise.resolve(remoteAccount) },
    );

    expect(refreshed.companion).toBeNull();
    expect(refreshed.account).toBe(remoteAccount);
  });

  it("keeps local Companion refreshes when account status fails", async () => {
    const companion = {
      enabled: true,
      keepAwake: false,
      port: 8811,
      devices: [],
      pairing: null,
    };
    const refreshed = await loadCompanionBridgeState(
      { state: () => Promise.resolve(companion) },
      { state: () => Promise.reject(new Error("account unavailable")) },
    );

    expect(refreshed.companion).toBe(companion);
    expect(refreshed.account).toBeNull();
  });

  it("does not let a pre-mutation poll overwrite a newly opened pairing", async () => {
    const pairingToken = `murage_pair_${"a".repeat(43)}`;
    const staleState: CompanionState = {
      enabled: true,
      keepAwake: false,
      port: 8811,
      devices: [],
      pairing: null,
    };
    const pairedState: CompanionState = {
      ...staleState,
      pairing: { code: "004209", token: pairingToken, expiresAt: Date.now() + 60_000 },
    };
    let signalCompanionRead = () => {};
    const companionRead = new Promise<void>((resolve) => {
      signalCompanionRead = resolve;
    });
    let resolveAccount = (_value: CompanionAccountState) => {};
    const accountRead = new Promise<CompanionAccountState>((resolve) => {
      resolveAccount = resolve;
    });
    const epoch = { current: 0 };
    const refreshEpoch = epoch.current;
    let visibleState: CompanionState | null = null;
    const refresh = loadCompanionBridgeState(
      {
        state: () => {
          signalCompanionRead();
          return Promise.resolve(staleState);
        },
      },
      { state: () => accountRead },
    ).then((next) => {
      if (next.companion && companionStateRefreshIsCurrent(epoch, refreshEpoch)) {
        visibleState = next.companion;
      }
      return next;
    });

    await companionRead;
    visibleState = await mutateCompanionBridgeState(epoch, () => Promise.resolve(pairedState));
    resolveAccount(account("ready"));
    const refreshed = await refresh;

    expect(refreshed.companion).toBe(staleState);
    expect(visibleState).toBe(pairedState);
    expect(epoch.current).toBe(2);
  });

  it("hydrates an untouched email field but preserves user edits", () => {
    const remoteAccount = { ...account("signed-out"), email: "old@example.com" };

    expect(shouldHydrateCompanionEmail(false, remoteAccount)).toBe(true);
    expect(shouldHydrateCompanionEmail(true, remoteAccount)).toBe(false);
  });
});

// `phonePairingManualCodeMode` used to live here, deciding whether the digits
// sat next to the QR or inside "Having trouble?" depending on whether a QR
// link could be built. That decision is gone: the code is always on screen,
// because the person it is for is the one who cannot scan.
describe("the sign-in panel names both ways in", () => {
  const qrLogin = () => {
    const source = readFileSync(
      fileURLToPath(new URL("./CompanionSection.tsx", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("function QrLogin");
    return source.slice(start, source.indexOf("export function CompanionSection", start));
  };

  it("tells the person where to type the code, not just what it is", () => {
    // The code was printed here with no address anywhere near it, which is
    // the exact dead end a second laptop hits: six digits and nowhere to put
    // them. `typedCodeInstruction` carries the door's own URL.
    const panel = qrLogin();
    expect(panel).toContain("companionDoorUrl");
    // Rendered, not merely computed: a helper called and never printed is the
    // same blank space beside the digits that sent Sean looking for a camera
    // on a laptop.
    expect(panel, "the address must reach the screen").toContain("{typed.url}");
    expect(panel).toContain("{typed.lead}");
  });

  it("does not sell the camera as the only route", () => {
    const panel = qrLogin();
    // The heading is the first thing read, and "Scan to sign in" is advice a
    // laptop cannot take.
    expect(panel).toMatch(/Scan it, or type the code/);
  });
});

describe("companion pairing availability", () => {
  const localCompanion = (enabled: boolean) => ({ enabled, endpoints: [] });
  const hostedCompanion = {
    enabled: true,
    endpoints: [
      { kind: "hosted" as const, url: "https://device.companion.example", priority: 0 },
    ],
  };

  it("waits while a signed-in account is provisioning its hosted route", () => {
    expect(companionPairingMode(account("connecting"), localCompanion(true))).toBe(
      "hosted-connecting",
    );
    expect(companionPairingMode(account("connecting"), localCompanion(false))).toBe(
      "hosted-connecting",
    );
  });

  it("starts a ready account when Companion is off, then waits for its hosted route", () => {
    expect(companionPairingMode(account("ready"), localCompanion(false))).toBe(
      "hosted-startable",
    );
    expect(companionPairingMode(account("ready"), localCompanion(true))).toBe(
      "hosted-connecting",
    );
  });

  it("allows pairing as soon as the hosted route is published", () => {
    expect(companionPairingMode(account("ready"), hostedCompanion)).toBe("hosted-ready");
    // The companion endpoint is the source of truth even if the separately
    // polled account state is one render behind.
    expect(companionPairingMode(account("connecting"), hostedCompanion)).toBe("hosted-ready");
  });

  it("preserves local-only pairing when hosted access is not configured or failed", () => {
    expect(companionPairingMode(account("signed-out"), localCompanion(true))).toBe("local-only");
    expect(
      companionPairingMode({ available: false, status: "signed-out" }, localCompanion(true)),
    ).toBe("local-only");
    expect(companionPairingMode(account("error"), localCompanion(true))).toBe("local-only");
  });
});

describe("the three-step strip fits the modal it lives in", () => {
  // A flex item keeps `min-width: auto` and refuses to shrink below its
  // content's intrinsic width. The longest detail line pushed its item past
  // its third of the row, overflowed the strip, and put a horizontal
  // scrollbar across the whole settings modal — visible in a screenshot, and
  // invisible to every test that reads behaviour rather than layout.
  it("lets each step shrink below its own text", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./CompanionSection.tsx", import.meta.url)),
      "utf8",
    );
    const strip = source.slice(source.indexOf("function StepStrip"));
    const item = strip.slice(0, strip.indexOf("</li>"));
    expect(item, "the flex ITEM needs min-w-0, not just the span inside it").toContain("flex min-w-0 flex-1");
  });

  it("still truncates the detail rather than wrapping the row taller", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./CompanionSection.tsx", import.meta.url)),
      "utf8",
    );
    const strip = source.slice(source.indexOf("function StepStrip"));
    expect(strip.slice(0, strip.indexOf("</ol>"))).toContain("truncate");
  });
});

describe("the remote access line when the tailnet has no certificates", () => {
  it("points at the steps rather than repeating the whole error above them", () => {
    const line = remoteAccessSummary({ on: false, desired: true, url: null, available: true, reason: "no-certificates",
      problem: "Your tailnet does not have HTTPS certificates turned on, so … https://login.tailscale.com/admin/dns …" }, null);
    expect(line).toBe("Off. Your tailnet needs HTTPS turned on first. The steps are below.");
  });
});

describe("the Tailscale account the phone needs", () => {
  const qrLogin = () => {
    const source = readFileSync(fileURLToPath(new URL("./CompanionSection.tsx", import.meta.url)), "utf8");
    const start = source.indexOf("function QrLogin");
    return source.slice(start, source.indexOf("export function CompanionSection", start));
  };

  it("names the computer's own account when the sidecar could read it", () => {
    expect(tailscaleAccountLine({ tailnetLogin: "sean@example.com" })).toBe(
      "On your phone, sign in to Tailscale as sean@example.com.",
    );
  });

  it("says nothing extra when the account is unknown", () => {
    expect(tailscaleAccountLine(null)).toBeNull();
    expect(tailscaleAccountLine({})).toBeNull();
    expect(tailscaleAccountLine({ tailnetLogin: "" })).toBeNull();
    expect(tailscaleAccountLine({ tailnetLogin: "   " })).toBeNull();
  });

  it("is shown beside the QR, not just computed", () => {
    const panel = qrLogin();
    expect(panel).toContain("tailscaleAccountLine(c.state)");
    expect(panel).toMatch(/\{account && /);
  });

  it("offers the Murage app and keeps the phone's camera and browser", () => {
    const panel = qrLogin();
    expect(panel).toMatch(/Scan it with the Murage app on your phone, or with your phone's camera/);
    expect(panel).toMatch(/browser/);
    expect(panel).not.toMatch(/\bapp store\b|\bdownload the app\b|\binstall the app\b/i);
  });
});

// First run on the phone sends people to Settings, then "Phone and other
// devices", and tells them to turn it on. The page has to be called that, and
// turning it on has to be one switch that ends with a code on screen: the
// browser door AND tailscale serve, together.
describe("one switch turns it on", () => {
  type Calls = string[];
  const base: CompanionState = { enabled: false, keepAwake: false, port: 8811, devices: [], pairing: null };
  const remote = (over: Partial<NonNullable<CompanionState["remoteAccess"]>>) => ({
    on: false, desired: false, url: null, available: true, reason: null, problem: null, ...over,
  });
  const fake = (calls: Calls, answers: {
    start?: CompanionState | Error;
    remote?: (enabled: boolean) => CompanionState | Error;
    stop?: CompanionState;
    state?: CompanionState;
  }) => ({
    state: () => { calls.push("state"); return Promise.resolve(answers.state ?? { ...base, enabled: true }); },
    start: () => {
      calls.push("start");
      return answers.start instanceof Error ? Promise.reject(answers.start) : Promise.resolve(answers.start ?? { ...base, enabled: true });
    },
    stop: () => { calls.push("stop"); return Promise.resolve(answers.stop ?? base); },
    remoteAccess: (enabled: boolean) => {
      calls.push(`remote:${enabled}`);
      const answer = answers.remote?.(enabled) ?? { ...base, enabled: true, remoteAccess: remote({ on: enabled, desired: enabled }) };
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  });

  it("starts the browser door, then asks for remote access", async () => {
    const calls: Calls = [];
    const next = await turnOnPhoneAccess(fake(calls, {}));
    expect(calls).toEqual(["start", "remote:true"]);
    expect(next.enabled).toBe(true);
    expect(next.remoteAccess?.on).toBe(true);
  });

  it("keeps the door on when Tailscale is missing, with the problem to show", async () => {
    const calls: Calls = [];
    const problem = "Tailscale is not installed on this computer.";
    const next = await turnOnPhoneAccess(fake(calls, {
      remote: () => ({ ...base, enabled: true, remoteAccess: remote({ available: false, reason: "missing", problem }) }),
    }));
    expect(calls).toEqual(["start", "remote:true"]);
    expect(next.enabled).toBe(true);
    expect(next.remoteAccess?.problem).toBe(problem);
  });

  it("does not ask for remote access when the door could not start", async () => {
    const calls: Calls = [];
    const next = await turnOnPhoneAccess(fake(calls, { start: { ...base, enabled: false, error: "sidecar stopped" } }));
    expect(calls).toEqual(["start"]);
    expect(next.error).toBe("sidecar stopped");
  });

  it("does not ask again when remote access is already on", async () => {
    const calls: Calls = [];
    await turnOnPhoneAccess(fake(calls, { start: { ...base, enabled: true, remoteAccess: remote({ on: true, desired: true }) } }));
    expect(calls).toEqual(["start"]);
  });

  it("turns both off, remote access first", async () => {
    const calls: Calls = [];
    await turnOffPhoneAccess(fake(calls, {}), remote({ on: true, desired: true }));
    expect(calls).toEqual(["remote:false", "stop"]);
    const plain: Calls = [];
    await turnOffPhoneAccess(fake(plain, {}), remote({}));
    expect(plain).toEqual(["stop"]);
  });

  it("a remote-access call that fails halfway shows the real state: the door is on (review fix 1)", async () => {
    const calls: Calls = [];
    const next = await turnOnPhoneAccess(fake(calls, {
      remote: () => new Error("sidecar restart failed"),
      state: { ...base, enabled: true },
    }));
    expect(calls).toEqual(["start", "remote:true", "state"]);
    expect(next.enabled).toBe(true);
    expect(next.remoteAccess?.on).toBe(false);
    expect(next.remoteAccess?.problem).toMatch(/Remote access could not be turned on/);
  });

  it("stop still runs when turning remote access off fails, and the real state comes back (review fix 2)", async () => {
    const calls: Calls = [];
    const next = await turnOffPhoneAccess(fake(calls, { remote: () => new Error("serve off failed") }), remote({ on: true, desired: true }));
    expect(calls).toEqual(["remote:false", "stop"]);
    expect(next.enabled).toBe(false);
    expect(next.remoteAccess?.problem).toMatch(/Remote access could not be turned off/);
  });

  it("a turn-on that does not end with the door on forgets the code request (review fix 3)", async () => {
    for (const answers of [
      { start: { ...base, enabled: false, error: "sidecar stopped" } },
      { start: { ...base, enabled: true, error: "sidecar stopped" } },
    ]) {
      let forgot = 0;
      await turnOnForCode(fake([], answers), () => { forgot += 1; });
      expect(forgot).toBe(1);
    }
    let forgot = 0;
    await expect(turnOnForCode(fake([], { start: new Error("ipc gone") }), () => { forgot += 1; })).rejects.toThrow("ipc gone");
    expect(forgot).toBe(1);
    let kept = 0;
    const on = await turnOnForCode(fake([], {}), () => { kept += 1; });
    expect([on.enabled, kept]).toEqual([true, 0]);
  });

  it("the switch turns on through turnOnForCode, which can clear the request", () => {
    const source = readFileSync(fileURLToPath(new URL("./CompanionSection.tsx", import.meta.url)), "utf8");
    expect(source).toContain("turnOnForCode(companion, () => setCodeWanted(false))");
  });

  it("shows the code as soon as it is on, once", () => {
    const on: CompanionState = { ...base, enabled: true };
    expect(shouldOpenCodeAfterTurnOn(true, on, false)).toBe(true);
    expect(shouldOpenCodeAfterTurnOn(false, on, false)).toBe(false);
    expect(shouldOpenCodeAfterTurnOn(true, on, true)).toBe(false);
    expect(shouldOpenCodeAfterTurnOn(true, base, false)).toBe(false);
    expect(shouldOpenCodeAfterTurnOn(true, { ...on, error: "x" }, false)).toBe(false);
    expect(shouldOpenCodeAfterTurnOn(true, { ...on, pairing: { code: "000000", token: "t", expiresAt: 1 } }, false)).toBe(false);
    expect(shouldOpenCodeAfterTurnOn(true, null, false)).toBe(false);
  });
});

describe("the page is called Phone and other devices", () => {
  const source = () => readFileSync(fileURLToPath(new URL("./CompanionSection.tsx", import.meta.url)), "utf8");
  const body = () => {
    const all = source();
    return all.slice(all.indexOf("export function CompanionSection("));
  };

  it("names the page for what it does, and never says WebUI", () => {
    expect(COMPANION_PAGE_TITLE).toBe("Phone and other devices");
    expect(body()).toContain("{COMPANION_PAGE_TITLE}");
    // Visible words only: an identifier like webUiSteps may keep its name.
    expect(source()).not.toMatch(/["'>]\s*(Enable )?WebUI\b/);
  });

  it("has one switch that turns it on, asked first, then shows the code", () => {
    const page = body();
    expect(TURN_ON_LABEL).toBe("Turn on");
    expect(page).toContain("{TURN_ON_LABEL}");
    const main = page.slice(page.indexOf("{TURN_ON_LABEL}"), page.indexOf("{SIGN_IN_CARD_TITLE}"));
    expect(main).toContain('setConfirming("both")');
    expect(main).toContain("turnOffPhoneAccess(");
    expect(page).toContain("turnOnForCode(companion,");
  });

  it("puts the code card at the top, the status and paired devices below", () => {
    const page = body();
    const at = (needle: string) => {
      const index = page.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(SIGN_IN_CARD_TITLE).toBe("Sign in on another device");
    expect(at("{TURN_ON_LABEL}")).toBeLessThan(at("title={SIGN_IN_CARD_TITLE}"));
    expect(at("title={SIGN_IN_CARD_TITLE}")).toBeLessThan(at("<StepStrip"));
    expect(at("<StepStrip")).toBeLessThan(at('title="Paired devices"'));
    // Remote access can still go off by itself, but a code never waits for it.
    expect(at('aria-label="Allow remote access"')).toBeGreaterThan(at("title={SIGN_IN_CARD_TITLE}"));
  });

  it("asks once about the tailnet, and the question covers both halves", () => {
    const all = source();
    const dialog = all.slice(all.indexOf("function ConfirmRemoteAccess"), all.indexOf("function StepStrip"));
    expect(dialog).toMatch(/the part of Murage that answers your other devices/);
    expect(dialog).toContain("tailscale serve");
    expect(dialog).toContain("Serve on my tailnet");
  });

  it("titles every state of the page with its name, even without the desktop bridge (review fix 4)", () => {
    const page = body();
    const noBridge = page.slice(page.indexOf("if (!companionBridge())"), page.indexOf("if (!state)"));
    expect(noBridge).toContain("title={COMPANION_PAGE_TITLE}");
    expect(page).not.toContain("title={WEB_UI_TITLE}");
  });

  it("names the switch's on-state line so the phone's picture can check it", () => {
    expect(TURN_ON_SUBTITLE).toBe("On. Scan the code below with the Murage app on your phone.");
    expect(body()).toContain("TURN_ON_SUBTITLE");
  });

  it("is the Settings tab's name too", () => {
    // 0.1.62: the Settings labels live in the catalog (lib/settings-sections.ts)
    expect(en["settings.section.companion"]).toBe(COMPANION_PAGE_TITLE);
  });
});

describe("removing a paired device asks first", () => {
  const source = () => readFileSync(fileURLToPath(new URL("./CompanionSection.tsx", import.meta.url)), "utf8");
  const props = () => ({ name: "Sean's iPhone", busy: false, onCancel: vi.fn(), onConfirm: vi.fn() });

  it("clicking the row's remove control only asks: it never calls revoke", () => {
    const src = source();
    const trash = src.slice(src.indexOf("aria-label={`Revoke ${device.name}`}") - 400, src.indexOf("aria-label={`Revoke ${device.name}`}"));
    expect(trash).toContain("setRevoking(device.id)");
    expect(trash).not.toContain("companion.revoke");
  });

  it("calls revoke from exactly one place: the confirm step", () => {
    const src = source();
    expect(src.match(/companion\.revoke\(/g)?.length).toBe(2); // the Replace flow's own confirm, and this one
    const confirmCall = src.slice(src.indexOf("<RevokeDeviceConfirm"), src.indexOf("<RevokeDeviceConfirm") + 700);
    expect(confirmCall).toContain("companion.revoke(device.id)");
    expect(confirmCall).toContain("onCancel={() => setRevoking(null)}");
  });

  it("names the device and says what happens, in the catalog's words", () => {
    const html = renderToStaticMarkup(createElement(RevokeDeviceConfirm, props()));
    expect(html).toContain("Remove Sean&#x27;s iPhone?");
    expect(html).toContain("Sean&#x27;s iPhone is signed out and must be paired again to use Murage.");
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Remove device");
  });

  it("confirming calls onConfirm once, cancelling calls onCancel and never onConfirm", () => {
    const p = props();
    const panel = RevokeDeviceConfirm(p) as any;
    const buttons = panel.props.children[2].props.children;
    const [cancel, confirm] = buttons;
    cancel.props.onClick();
    expect(p.onCancel).toHaveBeenCalledOnce();
    expect(p.onConfirm).not.toHaveBeenCalled();
    confirm.props.onClick();
    expect(p.onConfirm).toHaveBeenCalledOnce();
  });

  it("Cancel has the focus, the confirm button is the destructive style, Escape cancels", () => {
    const p = props();
    const panel = RevokeDeviceConfirm(p) as any;
    const [cancel, confirm] = panel.props.children[2].props.children;
    expect(cancel.props.autoFocus).toBe(true);
    expect(confirm.props.autoFocus).toBeFalsy();
    expect(confirm.props.className).toContain("bg-danger");
    const stop = vi.fn();
    panel.props.onKeyDown({ key: "Escape", stopPropagation: stop });
    expect(p.onCancel).toHaveBeenCalledOnce();
    panel.props.onKeyDown({ key: "Enter", stopPropagation: stop });
    expect(p.onCancel).toHaveBeenCalledOnce();
    expect(p.onConfirm).not.toHaveBeenCalled();
  });

  it("has no remove-all control, and the phone's own sign-out and the Replace flow already confirm", () => {
    expect(source()).not.toMatch(/remove all|revoke all|sign out everywhere/i);
    expect(readFileSync(fileURLToPath(new URL("./RemoteSignOut.tsx", import.meta.url)), "utf8")).toContain("setConfirming(true)");
    expect(readFileSync(fileURLToPath(new URL("./ReplaceOldDevice.tsx", import.meta.url)), "utf8")).toContain("setConfirming(device.id)");
  });

  it("keeps the new copy in the catalog, without banned words", () => {
    for (const key of ["phone.revoke.title", "phone.revoke.body", "phone.revoke.confirm", "phone.revoke.cancel"] as const) {
      expect(en[key]).toBeTruthy();
      expect(en[key]).not.toMatch(/\u2014|\bsafe|safety/i);
    }
  });
});
