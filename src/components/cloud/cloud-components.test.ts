// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CloudDevicesSettingsView, DEVICES_COPY, factorText } from "./CloudDevicesSettings";
import { CloudDisconnectComputer, CloudDisconnectComputerView } from "./CloudDisconnectComputer";
import type { HomeDevice } from "@/lib/cloud-door";
import { CloudReconnectingBannerView, CloudUnreachableBannerView, REATTACH_WINDOW_MS, bannerState, nextReachabilityCheckMs, wokeFromSleep } from "./CloudUnreachableBanner";
import { ConnectHomeView, connectSecondsLeft, formatCountdown, resultText, retrySecondsLeft, type ConnectHomeViewProps } from "./ConnectHome";
import en from "../../locales/en.json";
import { EngineSignInsView, type EngineSignInsViewProps } from "./EngineSignIns";
import { WorkspaceSwitch, WorkspaceSwitchView } from "./WorkspaceSwitch";
import { CLAUDE_CLOUD_RENEW_COPY } from "../EngineLoginTerminal";

const noop = () => {};
const signInBase: EngineSignInsViewProps = { homeId: "h2", busy: false, signIn: null, botChoices: null, onSignIn: noop, onChooseBot: noop, onCloseSignIn: noop };
const signIns = (over: Partial<EngineSignInsViewProps>) => renderToStaticMarkup(createElement(EngineSignInsView, { ...signInBase, ...over }));

describe("Cloud UI", () => {
  it("the banner says the home isn't reachable and that nothing is kept to send later", () => {
    const html = renderToStaticMarkup(createElement(CloudUnreachableBannerView, {}));
    expect(html).toContain("Your Cloud home isn&#x27;t reachable");
    expect(html).toContain("nothing is kept to send later");
    expect(html).toContain('role="alert"');
    expect(nextReachabilityCheckMs(false)).toBeLessThan(nextReachabilityCheckMs(true));
  });

  it("the switch offers This computer and Cloud home", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSwitchView, { onCloud: noop, pairing: false }));
    expect(html).toContain("This computer");
    expect(html).toContain("Cloud home");
  });

  it("without the bridge (flag off, or a browser) the switch renders nothing", () => {
    expect(renderToStaticMarkup(createElement(WorkspaceSwitch, {}))).toBe("");
  });

  it("a connected home on the Connect panel offers the engine sign-ins; without them wired the row has Open and Disconnect only", () => {
    const connectRow = (over: Partial<ConnectHomeViewProps>) => renderToStaticMarkup(createElement(ConnectHomeView, {
      phase: "paired", secondsLeft: 0, paired: [{ homeId: "h2", origin: "https://h.example" }], lastResult: null, retrySeconds: 0, busy: false, error: "", notice: "",
      onConnect: noop, onCancel: noop, onPaste: noop, onOpen: noop, onDisconnect: noop, ...over,
    }));
    expect(connectRow({})).not.toContain("Sign in to Claude");
    const wired = connectRow({ signIns: (homeId) => createElement(EngineSignInsView, { ...signInBase, homeId }) });
    expect(wired).toContain("Sign in to Claude");
    expect(wired).toContain("Sign in to Codex");
    expect(wired).toContain("Sign in to OpenCode");
    expect(wired).toContain("Save a Codex API key");
    expect(wired).not.toContain("Email me a code");
    expect(wired).not.toContain("6-digit code");
  });

  it("a per-bot sign-in asks which bot it is for before any terminal opens; Claude's opens at once", () => {
    const loading = signIns({ signIn: { homeId: "h2", engine: "codex", action: "login", bot: null }, botChoices: null });
    expect(loading).toContain("Choose which bot to sign this engine in for.");
    expect(loading).toContain("Loading the bots on this home");
    const choose = signIns({ signIn: { homeId: "h2", engine: "grokAgent", action: "login", bot: null }, botChoices: [{ id: "bot-atlas", name: "Atlas" }] });
    expect(choose).toMatch(/<button[^>]*>Atlas<\/button>/);
    expect(signIns({ signIn: { homeId: "h2", engine: "kimiAgent", action: "login", bot: null }, botChoices: [] })).toContain("This home has no bots yet");
    const chosen = signIns({ signIn: { homeId: "h2", engine: "codex", action: "login", bot: { id: "bot-atlas", name: "Atlas" } } });
    expect(chosen).not.toContain("Choose which bot");
    for (const signIn of [{ homeId: "h2", engine: "claudeAgent" as const, action: "login" as const }, { homeId: "h2", engine: "codex" as const, action: "enroll-key" as const }]) {
      expect(signIns({ signIn })).not.toContain("Choose which bot");
    }
    expect(signIns({ homeId: "h3", signIn: { homeId: "h2", engine: "codex", action: "login", bot: null } })).not.toContain("Choose which bot");
  });

  it("the engine card's renewal line starts with the home's own renewal words", () => {
    const source = readFileSync(new URL("../EnginesSettings.tsx", import.meta.url), "utf8");
    const line = /export const ENGINE_RENEW_COPY = "([^"]+)"/.exec(source)?.[1] ?? "";
    expect(line.startsWith(`${CLAUDE_CLOUD_RENEW_COPY}:`)).toBe(true);
    expect(readFileSync(new URL("../../../server/cloud-home/copy.ts", import.meta.url), "utf8")).toContain(`cloudClaudeSigninRenew: "${CLAUDE_CLOUD_RENEW_COPY}"`);
    expect(source).toContain("instance.snapshot.renewSignIn === true");
  });

  describe("Connect panel (Door v2)", () => {
    const connectBase: ConnectHomeViewProps = {
      phase: "idle", secondsLeft: 0, paired: [], lastResult: null, retrySeconds: 0, busy: false, error: "", notice: "",
      onConnect: noop, onCancel: noop, onPaste: noop, onOpen: noop, onDisconnect: noop,
    };
    const connect = (over: Partial<ConnectHomeViewProps>) => renderToStaticMarkup(createElement(ConnectHomeView, { ...connectBase, ...over }));
    const at = 1_000_000;

    it("idle offers one button and no code entry", () => {
      const html = connect({});
      expect(html).toContain("Connect to your Cloud home");
      expect(html).not.toContain("6-digit");
      expect(html).not.toContain("<input");
    });

    it("pending says to finish in the browser, counts down, and offers Use copied link and Cancel, with no text field", () => {
      const html = connect({ phase: "pending", secondsLeft: 125 });
      expect(html).toContain("Finish in your browser. This window carries on by itself.");
      expect(html).toContain("2:05");
      expect(html).toContain(">Use copied link</button>");
      expect(html).toContain("Cancel");
      expect(html).not.toContain("<input");
      expect(html).not.toContain("Paste link");
      expect(html).not.toContain("Connect again");
    });

    it("while Cloud is not open on this build it says so in plain words and offers no Connect, no paste and no countdown", () => {
      const html = connect({ phase: "closed", lastResult: { code: "expired", message: "m", at } });
      expect(html).toContain("Murage Cloud is not open yet. Connect will be here as soon as it is.");
      expect(html).toContain('role="status"');
      expect(html).not.toContain("<button");
      expect(html).not.toContain("Use copied link");
      expect(html).not.toContain("Time left");
    });

    it("connect: refusal stays visible after pending ends", () => {
      const refused = { code: "hold-required", message: "main's words", at };
      const whilePending = connect({ phase: "pending", secondsLeft: 300, lastResult: refused });
      expect(whilePending).toContain("Start adding this computer on My Cloud. It can connect after the 72-hour check.");
      // The countdown ran out (or Cancel was pressed): no pending Connect any more, and the refusal is still there.
      const afterwards = connect({ phase: "idle", lastResult: refused });
      expect(afterwards).toContain("Start adding this computer on My Cloud. It can connect after the 72-hour check.");
      expect(afterwards).toContain('role="alert"');
      expect(afterwards).toContain("Connect to your Cloud home</button>");
      const tooLong = connect({ phase: "idle", lastResult: { code: "took-too-long", message: "m", at } });
      expect(tooLong).toContain("That took longer than ten minutes. Press Connect to start again.");
      expect(tooLong).toContain('role="status"');
    });

    it("a lost answer has no countdown and offers Connect again with the same key, Use copied link and Cancel", () => {
      const html = connect({ phase: "attempted", lastResult: { code: "lost", message: "m", at } });
      expect(html).toContain("the answer didn&#x27;t arrive. Press Connect again; it uses the same key, so no new 72-hour check.");
      expect(html).not.toContain("Time left");
      expect(html).toContain(">Connect again</button>");
      expect(html).toContain(">Use copied link</button>");
      expect(html).toContain(">Cancel</button>");
      expect(connect({ phase: "idle", lastResult: { code: "remove-on-my-cloud", message: "m", at } })).toContain("If this computer appears on My Cloud, remove it there.");
    });

    it("a 429 counts down before Connect can run again", () => {
      const tries = { code: "too-many-tries", message: "m", at, retryAfterMs: 600_000 };
      expect(retrySecondsLeft(tries, at + 19_000)).toBe(581);
      expect(retrySecondsLeft(tries, at + 700_000)).toBe(0);
      expect(retrySecondsLeft({ code: "refused", message: "m", at }, at)).toBe(0);
      const html = connect({ phase: "idle", lastResult: tries, retrySeconds: 581 });
      expect(html).toContain("Too many tries. Wait ten minutes, then press Connect again.");
      expect(html).toContain("9:41");
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect to your Cloud home<\/button>/);
    });

    it("every wire reason and outcome has its own words, from en.json, plain and without dashes or the word safe", () => {
      const codes = ["expired", "hold-required", "too-many-devices", "refused", "too-many-tries", "home-busy", "lost", "took-too-long", "remove-on-my-cloud", "other-connect", "bad-link", "pin-mismatch", "unreachable"];
      const texts = codes.map((code) => resultText({ code, message: "FALLBACK", at }));
      expect(new Set(texts).size).toBe(codes.length);
      for (const text of texts) {
        expect(text).not.toBe("FALLBACK");
        expect(Object.values(en)).toContain(text);
        expect(text).not.toMatch(/\u2014|\b(?:safe|safely|safety|unsafe)\b/i);
      }
      expect(resultText({ code: "something-new", message: "main's own words", at })).toBe("main's own words");
    });

    it("a revoked computer says so; paired offers Open and Disconnect", () => {
      expect(connect({ notice: "This computer was disconnected from your Cloud home. Connect it again." })).toContain("disconnected from your Cloud home");
      const paired = connect({ phase: "paired", paired: [{ homeId: "h1", origin: "https://h.example" }], lastResult: { code: "lost", message: "m", at } });
      expect(paired).toContain("Open");
      expect(paired).toContain("Disconnect this computer");
      expect(paired).not.toContain("answer didn");
    });

    it("the countdown is ten minutes and never goes below zero", () => {
      expect(connectSecondsLeft(1_000, 1_000)).toBe(600);
      expect(connectSecondsLeft(1_000, 1_000 + 600_000)).toBe(0);
      expect(connectSecondsLeft(1_000, 9_999_999)).toBe(0);
      expect(formatCountdown(600)).toBe("10:00");
      expect(formatCountdown(59)).toBe("0:59");
    });
  });

  describe("reattach after sleep or a network change", () => {
    const down = { ok: false as const, code: "unreachable", message: "Your Cloud home isn't reachable" };
    it("says Reconnecting while main reattaches, and the unreachable banner only after that", () => {
      const now = 1_000_000;
      expect(bannerState({ ok: true }, now + REATTACH_WINDOW_MS, now)).toEqual({ kind: "ok" });
      expect(bannerState(down, now + 1, now)).toEqual({ kind: "reconnecting" });
      expect(bannerState(down, now, now)).toEqual({ kind: "unreachable", message: down.message });
      expect(bannerState(down, 0, now)).toEqual({ kind: "unreachable", message: down.message });
      expect(nextReachabilityCheckMs(false, true)).toBeLessThan(nextReachabilityCheckMs(false));
    });
    it("goes to the Connect panel only when the sign-in is refused", () => {
      expect(bannerState({ ok: false, code: "disconnected", message: "m" }, 0, 1)).toEqual({ kind: "disconnected" });
      expect(bannerState({ ok: false, code: "disconnected", message: "m" }, 10, 1)).toEqual({ kind: "disconnected" });
      expect(bannerState({ ok: false, code: "suspended", message: "paused" }, 0, 1)).toEqual({ kind: "suspended", message: "paused" });
      for (const code of ["unreachable", "pin-mismatch", "needs-repair", "sign-in-refused", undefined]) expect(bannerState({ ok: false, code, message: "" }, 10, 1).kind).toBe("reconnecting");
    });
    it("a late heartbeat is a wake from sleep", () => {
      expect(wokeFromSleep(0, 5_000)).toBe(false);
      expect(wokeFromSleep(0, 120_000)).toBe(true);
    });
    it("the reconnecting line is plain and polite, not an alert", () => {
      const html = renderToStaticMarkup(createElement(CloudReconnectingBannerView, {}));
      expect(html).toContain("Reconnecting to your Cloud home");
      expect(html).toContain('role="status"');
      expect(html).not.toContain('role="alert"');
    });
  });

  describe("Disconnect this computer in the Cloud window's Settings", () => {
    it("offers the one button with plain copy", () => {
      const html = renderToStaticMarkup(createElement(CloudDisconnectComputerView, { busy: false, error: "", done: false, onDisconnect: noop }));
      expect(html).toContain(">Disconnect this computer</button>");
      expect(html).not.toMatch(/\u2014|\bsafe\b|unsafe/i);
      expect(renderToStaticMarkup(createElement(CloudDisconnectComputerView, { busy: false, error: "Could not disconnect this computer. Try again.", done: false, onDisconnect: noop }))).toContain('role="alert"');
    });
    it("shows nothing without the Cloud window's bridge", () => {
      expect(renderToStaticMarkup(createElement(CloudDisconnectComputer, {}))).toBe("");
      expect(renderToStaticMarkup(createElement(CloudDisconnectComputer, { bridge: { disconnectThisComputer: async () => ({ disconnected: true as const }) } }))).toContain("Disconnect this computer");
    });
  });

  describe("Devices on a Cloud home: owner state and Make chat-only", () => {
    const device = (over: Partial<HomeDevice>): HomeDevice => ({ id: "d", scope: "browser", addedAt: 0, lastSeenAt: 1_700_000_000_000, keyHash: "aa", ...over });
    const view = (devices: HomeDevice[]) => renderToStaticMarkup(createElement(CloudDevicesSettingsView, { devices, mine: null, failed: false, busy: false, onForget: noop, onMakeChatOnly: noop }));
    const expiresAt = 1_800_000_000_000;

    it("a remembered-owner row says Owner until the date and offers Make chat-only", () => {
      const html = view([device({ id: "r1", factor: "remembered-owner", factorExpiresAt: expiresAt })]);
      expect(html).toContain(`${DEVICES_COPY.ownerUntil} ${new Date(expiresAt).toLocaleDateString()}`);
      expect(html).toContain(`>${DEVICES_COPY.makeChatOnly}</button>`);
      expect(factorText(device({ factor: "remembered-owner", factorExpiresAt: expiresAt }))).toBe(`Owner until ${new Date(expiresAt).toLocaleDateString()}`);
    });

    it("a chat-only row (no factor) says Chat only and offers no factor action", () => {
      const html = view([device({ id: "c1", factor: null })]);
      expect(html).toContain(DEVICES_COPY.chatOnly);
      expect(html).not.toContain(DEVICES_COPY.makeChatOnly);
      expect(html).not.toContain(DEVICES_COPY.ownerUntil);
      expect(factorText(device({ factor: false }))).toBe("Chat only");
    });

    it("a passkey row says Owner with no expiry and offers no Make chat-only", () => {
      const html = view([device({ id: "p1", factor: "passkey" })]);
      expect(html).toContain(`>${DEVICES_COPY.owner}</span>`);
      expect(html).not.toContain(DEVICES_COPY.ownerUntil);
      expect(html).not.toContain(DEVICES_COPY.makeChatOnly);
      expect(factorText(device({ factor: "passkey" }))).toBe("Owner");
    });

    it("keeps Forget this browser and uses plain words with no dashes or the word safe", () => {
      const html = view([device({ id: "r1", factor: "remembered-owner", factorExpiresAt: expiresAt }), device({ id: "c1", factor: null })]);
      expect(html).toContain(`>${DEVICES_COPY.forget}</button>`);
      for (const text of Object.values(DEVICES_COPY)) expect(text).not.toMatch(/–|—|\b(?:safe|safely|safety|unsafe)\b/i);
    });
  });
});
