// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SIMPLE-COPY (designs/settings-pages-1019/PAGES-B-astra.md section 6, A4, A9, B2, B3, B5, B6 S4c, R1, R2, 10.1): the plain
// Simple text of Messaging apps, Backups and Phone and devices, checked as data. Words are counted with `countWords` only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { countWords, bannedIn } from "./simple-copy-words";
import {
  CONFIRM_SIMPLE_LINES, CONFIRM_SIMPLE_TITLE, PHONE_HOW_THIS_WORKS_LINES, PhoneHowThisWorks, QR_LINE_SIMPLE_NOT_READY, QR_LINE_SIMPLE_READY,
  REMOTE_ON_NOTE_SIMPLE, REMOTE_PROBLEM_SIMPLE, TURN_ON_OFF_SUBTITLE_ADVANCED, TURN_ON_SUBTITLE, phoneAppReady, remoteAccessSummary,
  remoteAccessSummaryParts, simpleStatusLine, turnOnSubtitle, webUiSteps, type WebUiStep,
} from "../../CompanionSection";
import type { CompanionRemoteAccess, CompanionState } from "../../PhoneSetupFlow";
import { TAILSCALE_DNS_ADMIN_URL, tailnetHttpsHelp } from "../../../lib/tailnet-https";
import { KEEP_AWAKE_DETAIL, KEEP_AWAKE_DETAIL_SIMPLE } from "../../../lib/keep-awake";
import { PHONE_TOOLS_BODY_SIMPLE, PREVIEW_COPY } from "../../PhonePreviewSwitches";
import { telegramHealthLabel } from "../../../lib/telegram-status";
import { TelegramHowThisWorks } from "../../TelegramSettings";
import { SlackHowThisWorks, slackHealth, slackHelp } from "../../SlackSettings";
import { DiscordHowThisWorks, discordHealth, discordHelp } from "../../DiscordSettings";
import { WhatsAppHowThisWorks } from "../../WhatsAppSettings";
import {
  BackupHeadlineHowThisWorks, RecoveryKeyHowThisWorks, RestoreHowThisWorks, ScheduleSetupHowThisWorks,
} from "../../BackupSettings";
import {
  CLOSED_APP_FILE_SHARED_REASON_SIMPLE, CLOSED_JOB_MOVED_REASON, CLOSED_JOB_MOVED_REASON_SIMPLE, closedAppFileSharedReason, closedJobBlockedReason,
} from "../../backups-section-ui";
import { CLOSED_VOLUME_SENTENCES } from "../../../../shared/closed-volume-sentences.mjs";

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => text(renderToStaticMarkup(node));
const source = (file: string) => readFileSync(join(process.cwd(), "src", file), "utf8").replace(/\s+/g, " ");

const remote = (extra: Partial<CompanionRemoteAccess> = {}): CompanionRemoteAccess => ({ on: false, desired: false, url: null, available: true, reason: null, problem: null, ...extra });
const URL_ON = "https://murage-box.tail0a1b.ts.net";

/** Prose in Simple: at most 20 words and no banned word for its page. */
const expectPlain = (value: string, page: "phone" | "messaging" | "backups", cap = 20) => {
  expect(bannedIn(value, page), value).toEqual([]);
  expect(countWords(value), value).toBeLessThanOrEqual(cap);
};

describe("countWords (R2)", () => {
  it("counts whitespace tokens that hold a letter or a digit", () => {
    expect(countWords("Also \"back up\" couldn't Wi-Fi · … 2 x")).toBe(7);
    expect(countWords("")).toBe(0);
  });
  it("matches Astra's count of the 41-word original that started the guard", () => {
    expect(countWords(CLOSED_JOB_MOVED_REASON)).toBe(41);
  });
});

describe("Phone helpers (S3, B1, B4, B5, R1)", () => {
  it("remoteAccessSummary(simple) is plain on every branch, and Advanced keeps today's five sentences exactly", () => {
    const cases: Array<[string, CompanionRemoteAccess, string]> = [
      ["on", remote({ on: true, url: URL_ON }), `On. Any device signed into your tailnet can open ${URL_ON}.`],
      ["no-certificates", remote({ reason: "no-certificates" }), "Off. Your tailnet needs HTTPS turned on first. The steps are below."],
      ["problem", remote({ problem: "serve exploded" }), "serve exploded"],
      ["unavailable", remote({ available: false }), "Tailscale is not installed on this computer, so there is no secure address to serve."],
      ["default", remote(), "Off. Murage is reachable at a plain HTTP address inside your tailnet. Turning this on puts your tailnet's own HTTPS certificate in front, so the link has no port to type and works on any browser."],
    ];
    for (const [name, value, advanced] of cases) {
      const simple = remoteAccessSummary(value, "http://100.64.0.7:4317", "simple");
      expect(simple, name).not.toBe(advanced);
      expectPlain(simple.split(URL_ON).join(""), "phone");
      expect(remoteAccessSummary(value, "http://100.64.0.7:4317", "advanced"), name).toBe(advanced);
      expect(remoteAccessSummary(value, "http://100.64.0.7:4317"), name).toBe(advanced);
    }
  });
  it("the on branch carries the supplied address as its own part (B4), and the string helper agrees", () => {
    const value = remote({ on: true, url: URL_ON });
    const parts = remoteAccessSummaryParts(value, null, "simple");
    expect(parts.value).toBe(URL_ON);
    expect(parts.lead + parts.value + parts.tail).toBe(remoteAccessSummary(value, null, "simple"));
    expectPlain(parts.lead + parts.tail, "phone");
    expect(remoteAccessSummaryParts(remote(), null, "simple").value).toBe("");
  });
  it("simpleStatusLine is plain for every combination of the three steps", () => {
    const states = ["done", "current", "waiting"] as const;
    const lines = new Set<string>();
    for (const a of states) for (const b of states) for (const c of states) {
      const steps = [a, b, c].map((state) => ({ label: "x", state, detail: "y" }) as WebUiStep);
      const line = simpleStatusLine(steps);
      expectPlain(line, "phone");
      lines.add(line);
    }
    expect([...lines].sort()).toEqual([
      "Off. Turn on to pair a device.", "On, with a secure link for your devices.", "On. A browser on your devices can open it now.", "Starting. Waiting for an address.",
    ]);
    const old = webUiSteps({ state: null, remoteAccess: remote(), doorAddress: null }).map((step) => step.label);
    expect(old).toEqual(["Open the browser door", "Get the address", "Reach it from anywhere"]);
  });
  it("tailnetHttpsHelp(simple) uses the real fields, plain words, and the same link (B5)", () => {
    const value = remote({ reason: "no-certificates" });
    const simple = tailnetHttpsHelp(value, "simple")!;
    const advanced = tailnetHttpsHelp(value, "advanced")!;
    expect(Object.keys(simple).sort()).toEqual(["after", "linkLabel", "steps", "title", "url"]);
    for (const line of [simple.title, simple.linkLabel, simple.after, ...simple.steps]) expectPlain(line, "phone");
    expect(simple.url).toBe(TAILSCALE_DNS_ADMIN_URL);
    expect(advanced.url).toBe(TAILSCALE_DNS_ADMIN_URL);
    expect(simple.title).toBe("Turn on secure links in Tailscale");
    expect(simple.linkLabel).toBe("Open Tailscale settings");
    expect(simple.after).toBe("A one-time switch. Until then, a browser can still open Murage, but the Murage phone app needs the secure link.");
    expect(advanced.title).not.toBe(simple.title);
    expect(tailnetHttpsHelp(value)).toEqual(advanced);
  });
  it("turnOnSubtitle: six branches, plain in both modes, never promises a scan the phone app cannot do (B1)", () => {
    const base = { enabled: true, doorAddress: "http://100.64.0.7:4317", remote: remote(), lanOn: false };
    const branches: Array<[string, Parameters<typeof turnOnSubtitle>[0]]> = [
      ["off", { ...base, enabled: false }], ["ready", { ...base, remote: remote({ on: true }) }], ["no address", { ...base, doorAddress: null }],
      ["no-certificates", { ...base, remote: remote({ reason: "no-certificates" }) }], ["tailscale missing", { ...base, remote: remote({ available: false }) }], ["otherwise", base],
    ];
    for (const mode of ["simple", "advanced"] as const) for (const [name, input] of branches) {
      const line = turnOnSubtitle(input, mode);
      expectPlain(line, "phone");
      if (name !== "ready") expect(line, `${mode} ${name}`).not.toContain("Scan the code below with the Murage app");
    }
    expect(turnOnSubtitle(branches[1][1], "simple")).toBe(TURN_ON_SUBTITLE);
    expect(turnOnSubtitle(branches[0][1], "simple")).toBe("Open Murage on your phone, tablet or another computer.");
    expect(turnOnSubtitle(branches[0][1], "advanced")).toBe(TURN_ON_OFF_SUBTITLE_ADVANCED);
    expect(turnOnSubtitle(branches[2][1], "simple")).toBe("On. Starting, waiting for an address.");
    expect(turnOnSubtitle(branches[3][1], "simple")).toBe("On. A browser can sign in now. The phone app needs a secure link: steps below.");
    expect(turnOnSubtitle(branches[4][1], "simple")).toBe("On. To add your phone, pair over Wi-Fi under Sign in on another device.");
    expect(turnOnSubtitle(branches[5][1], "simple")).toBe("On. A browser can sign in now. For the phone app, turn on Allow remote access below.");
  });
  it("phoneAppReady reads the real Wi-Fi route, never the saved switch (R1)", () => {
    const lan = (on: boolean, mode: string | null) => ({ lanPairing: { on, chosen: true, mode, unencrypted: true, note: null } }) as unknown as CompanionState;
    const off = remote();
    expect(phoneAppReady(lan(true, "loopback"), off), "override: setting true, inherited bind loopback").toBe(false);
    expect(phoneAppReady(lan(true, "tailnet"), off)).toBe(false);
    expect(phoneAppReady(lan(true, "lan"), off), "operator bind lan, setting false").toBe(true);
    expect(phoneAppReady(lan(false, "lan"), off)).toBe(true);
    expect(phoneAppReady({} as CompanionState, off)).toBe(false);
    expect(phoneAppReady(null, off)).toBe(false);
    expect(phoneAppReady(lan(true, "loopback"), remote({ on: true }))).toBe(true);
    // The override case never reaches the scan line: Tailscale present gives branch 6, missing gives branch 5.
    const input = { enabled: true, doorAddress: "http://100.64.0.7:4317", lanOn: lan(true, "loopback").lanPairing!.mode === "lan" };
    expect(turnOnSubtitle({ ...input, remote: remote() }, "simple")).toContain("turn on Allow remote access");
    expect(turnOnSubtitle({ ...input, remote: remote({ available: false }) }, "simple")).toContain("pair over Wi-Fi");
  });
  it("the other Simple Phone lines are plain", () => {
    for (const line of [QR_LINE_SIMPLE_READY, QR_LINE_SIMPLE_NOT_READY, REMOTE_PROBLEM_SIMPLE, REMOTE_ON_NOTE_SIMPLE, KEEP_AWAKE_DETAIL_SIMPLE, PHONE_TOOLS_BODY_SIMPLE, ...CONFIRM_SIMPLE_LINES, ...Object.values(CONFIRM_SIMPLE_TITLE)]) expectPlain(line, "phone");
    expect(PREVIEW_COPY.phoneTools.body).not.toBe(PHONE_TOOLS_BODY_SIMPLE);
    expect(KEEP_AWAKE_DETAIL).not.toBe(KEEP_AWAKE_DETAIL_SIMPLE);
  });
  it("Phone How this works renders every line, in plain words (S2 with it opened), and holds the moved keep-awake detail", () => {
    const html = render(createElement(PhoneHowThisWorks));
    for (const line of PHONE_HOW_THIS_WORKS_LINES) {
      expect(html).toContain(line);
      expect(bannedIn(line, "phone"), line).toEqual([]);
    }
    expect(html).toContain(KEEP_AWAKE_DETAIL);
    expect(html).toContain("or over the same Wi-Fi if you turn that on");
  });
});

describe("Messaging helpers and How this works (S3, S4c)", () => {
  it("health labels say Not set up and keys, in every state", () => {
    const slack = { state: "idle", configured: false, appConfigured: false, botConfigured: false, paired: false, enabled: false, requiresRevoke: false, busy: false, pending: 0, uncertain: 0, rejected: 0, needsReview: 0, error: null, nextRetryAt: null };
    for (const state of ["idle", "verifying", "pairing", "connected", "retry", "blocked"]) for (const configured of [false, true]) for (const paired of [false, true]) for (const expired of [false, true]) {
      const status = { ...slack, state, configured, paired, enabled: paired } as never;
      expectPlain(slackHealth(status, expired), "messaging");
      expectPlain(discordHealth(status, expired), "messaging");
    }
    expect(slackHealth(slack as never)).toBe("Not set up");
    expect(discordHealth(slack as never)).toBe("Not set up");
    expect(slackHealth({ ...slack, configured: true } as never)).toBe("Keys saved · not paired yet");
    expect(telegramHealthLabel({ configured: false, enabled: false, paired: false, pending: 0, uncertain: 0, connecting: false } as never, false, false)).toBe("Not set up");
    expect(telegramHealthLabel(null, false, false)).toBe("Checking Telegram…");
  });
  it("every help code is plain; unknown codes too", () => {
    const codes = ["chief-changed", "identity-mismatch", "pair-required", "revoke-recovery-required", "connection-recovery-required", "retry-limit", "pairing-failed", "intake-failed", "delivery-failed", "transport-error", "ack-slow", "gateway-reconnecting", "gateway-blocked", "nope"];
    for (const code of codes) for (const help of [slackHelp(code), discordHelp(code)]) expectPlain(help!, "messaging", 40);
    expect(discordHelp("gateway-blocked")).toContain("Discord rejected the connection.");
  });
  it("S4c: Telegram How this works renders each branch and every moved sentence", () => {
    const all = (props: { configured: boolean; paired: boolean; replaceable: boolean }) => render(createElement(TelegramHowThisWorks, props));
    const first = all({ configured: false, paired: false, replaceable: false });
    expect(first).toContain("Message your Chief of Staff from Telegram.");
    expect(first).toContain("Your token will be stored encrypted on this computer and will not be shown again here.");
    expect(first).not.toContain("Connected. Send your bot");
    expect(all({ configured: true, paired: false, replaceable: false })).toContain("Your token is saved securely on this computer. You do not need to enter it again.");
    expect(all({ configured: true, paired: true, replaceable: false })).toContain("Connected. Send your bot a message in Telegram to talk to your Chief. Use owner-only buttons to allow once or deny pending actions. Other reviews stay in Murage.");
    expect(all({ configured: true, paired: true, replaceable: true })).toContain("Paste a new token for the same bot from BotFather. Your pairing and owner link are kept. A token for a different bot is refused.");
  });
  it("S4c: Slack, Discord and WhatsApp How this works render their moved sentences", () => {
    expect(render(createElement(SlackHowThisWorks))).toContain("Stored encrypted on this computer. Saved keys are never shown here; leave a saved key blank to keep it.");
    expect(render(createElement(SlackHowThisWorks))).toContain("Saving keys does not start pairing.");
    expect(render(createElement(DiscordHowThisWorks)).length).toBeGreaterThan(100);
    expect(render(createElement(WhatsAppHowThisWorks)).length).toBeGreaterThan(50);
  });
});

describe("Backups copy (S3, S4c, B2, R2)", () => {
  // Literal copies of the 350770409 text: the Advanced originals must stay word for word.
  const BASE = {
    refused: "Your system didn't let Murage register a background job, so backups run only while Murage is open.",
    shared: "Other accounts on this computer can change Murage's data folder, so backups run only while Murage is open.",
    wontRun: "Murage set up its background job, but your system couldn't start it, so backups run only while Murage is open. Tick \"Also back up when Murage is closed\" again to retry.",
    moved: "You opened Murage from a different app file, and its background job couldn't be moved to it, so backups run only while Murage is open. Tick \"Also back up when Murage is closed\" again to set it up for this copy.",
    outdated: "Murage's background job was set up by an earlier version and couldn't be updated, so backups run only while Murage is open. Tick \"Also back up when Murage is closed\" again to set it up for this version.",
    fileNamed: (file: string) => `Other accounts on this computer can change the Murage app file ${file}, so backups run only while Murage is open. To fix it, run chmod 755 '${file}' in a terminal, then come back here.`,
    fileUnnamed: "Other accounts on this computer can change the Murage app file, so backups run only while Murage is open. To fix it, run chmod 755 on the Murage app file in a terminal, then come back here.",
  };
  const closed = (blocked: string | undefined, extra: Record<string, unknown> = {}) => ({ supported: true, state: blocked ? "blocked" : "unavailable", blocked, ...extra }) as never;
  const reason = (blocked: string | undefined, pageMode?: "simple" | "advanced", extra: Record<string, unknown> = {}, setupFailed = false) =>
    closedJobBlockedReason({ bridge: true, closed: closed(blocked, extra), stale: false, setupFailed, pageMode });
  const blockedValues = ["data-folder-shared", "app-file-shared", "job-wont-run", "app-moved", "job-outdated", ...Object.keys(CLOSED_VOLUME_SENTENCES), undefined];

  it("every Simple fault line is at most 40 words with no Backups banned word (Simple outputs only)", () => {
    for (const blocked of blockedValues) for (const extra of [{}, { appFile: "/home/ada/Murage.AppImage" }]) {
      const line = reason(blocked, "simple", extra);
      if (line === null) continue;
      if (blocked === "app-file-shared") expect(line).toBe(CLOSED_APP_FILE_SHARED_REASON_SIMPLE);
      const rest = blocked === "app-file-shared" ? line : line;
      expect(countWords(rest), `${blocked}: ${line}`).toBeLessThanOrEqual(40);
      if (blocked === "app-file-shared" || blocked === "app-moved") expect(bannedIn(line, "backups"), line).toEqual([]);
    }
    expect(countWords(CLOSED_JOB_MOVED_REASON_SIMPLE)).toBeLessThanOrEqual(40);
    expect(reason(undefined, "simple", {}, true)).not.toBeNull();
  });
  it("Advanced and no-mode callers get the base text word for word (SIMPLE_ONLY)", () => {
    for (const mode of [undefined, "advanced"] as const) {
      expect(reason("data-folder-shared", mode)).toBe(BASE.shared);
      expect(reason("job-wont-run", mode)).toBe(BASE.wontRun);
      expect(reason("app-moved", mode)).toBe(BASE.moved);
      expect(reason("job-outdated", mode)).toBe(BASE.outdated);
      expect(reason(undefined, mode, {}, true)).toBe(BASE.refused);
      expect(reason("app-file-shared", mode, { appFile: "/home/ada/Murage.AppImage" })).toBe(BASE.fileNamed("/home/ada/Murage.AppImage"));
      expect(reason("app-file-shared", mode)).toBe(BASE.fileUnnamed);
      expect(closedAppFileSharedReason("/x/y", mode)).toBe(BASE.fileNamed("/x/y"));
    }
    expect(CLOSED_JOB_MOVED_REASON).toBe(BASE.moved);
  });
  it("S4c: every Backups How this works branch renders its moved sentences", () => {
    expect(render(createElement(BackupHeadlineHowThisWorks, { interrupted: true }))).toContain("The last backup stopped before Murage could confirm it, so backups are paused.");
    expect(render(createElement(BackupHeadlineHowThisWorks, { interrupted: false }))).toBe("");
    const setup = (props: { refsChosen: boolean; existingKeyFlow: boolean; platform?: string; closedSupported: boolean }) => render(createElement(ScheduleSetupHowThisWorks, props));
    expect(setup({ refsChosen: false, existingKeyFlow: false, closedSupported: true })).toContain("Murage can save an encrypted copy of your settings, conversations, files and message history every day.");
    expect(setup({ refsChosen: false, existingKeyFlow: true, closedSupported: true })).toContain("Murage makes your recovery key for you");
    expect(setup({ refsChosen: true, existingKeyFlow: true, closedSupported: true })).toContain("Your recovery key opens your backups.");
    expect(setup({ refsChosen: true, existingKeyFlow: true, closedSupported: false, platform: "win32" })).toContain("isn't available on Windows yet");
    expect(setup({ refsChosen: true, existingKeyFlow: true, closedSupported: true })).toContain("To turn on, set a time and the backup limits, then tick the box above.");
    expect(render(createElement(RecoveryKeyHowThisWorks))).toContain("without it nobody, including you, can get your work back");
    const restore = (props: { offsite: boolean; sftp: boolean; listed: boolean; downloaded: boolean }) => render(createElement(RestoreHowThisWorks, props));
    expect(restore({ offsite: false, sftp: false, listed: false, downloaded: false })).toContain("Backup mode closes this window and opens a separate recovery screen.");
    expect(restore({ offsite: true, sftp: true, listed: false, downloaded: false })).toContain("add the SFTP destination there");
    expect(restore({ offsite: true, sftp: false, listed: true, downloaded: true })).toContain("Listed copies are not verified yet.");
    expect(restore({ offsite: true, sftp: false, listed: true, downloaded: true })).toContain("Finish current work, then open Backup mode.");
  });
});

// ---- the three lists (B3). Each entry names the file under src/ and the exact text. ----
interface Entry { file: string; old: string; next?: string }
const MOVED: Entry[] = [
  { file: "components/CompanionSection.tsx", old: "Over your own tailnet, never the internet." },
  { file: "components/CompanionSection.tsx", old: "Optional: plain HTTP inside your tailnet works now." },
  { file: "components/CompanionSection.tsx", old: "Serve Murage on your tailnet?" },
  { file: "components/CompanionSection.tsx", old: "Serve on my tailnet" },
  { file: "components/CompanionSection.tsx", old: "Recent activity" },
  { file: "components/CompanionSection.tsx", old: "View guide" },
  { file: "lib/keep-awake.ts", old: "This stops it going to sleep on its own. Closing the lid still puts a laptop to sleep." },
  { file: "components/PhonePreviewSwitches.tsx", old: "Let your bots check and add to this phone's calendar, reminders, contacts, alarms and rough location. You approve each request on the phone." },
  { file: "components/TelegramSettings.tsx", old: "Connected. Send your bot a message in Telegram to talk to your Chief. Use owner-only buttons to allow once or deny pending actions. Other reviews stay in Murage." },
  { file: "components/TelegramSettings.tsx", old: "Paste a new token for the same bot from BotFather. Your pairing and owner link are kept. A token for a different bot is refused." },
  { file: "components/SlackSettings.tsx", old: "Stored encrypted on this computer. Saved keys are never shown here; leave a saved key blank to keep it." },
  { file: "components/BackupSettings.tsx", old: "The last backup stopped before Murage could confirm it, so backups are paused." },
  { file: "components/backups-section-ui.ts", old: "You opened Murage from a different app file, and its background job couldn't be moved to it" },
];
const RENAMED_BOTH: Entry[] = [
  ...["Slack", "Discord"].flatMap((app) => [
    { file: `components/${app}Settings.tsx`, old: "Credentials saved · not paired", next: "Keys saved · not paired yet" },
    { file: `components/${app}Settings.tsx`, old: `Save your ${app} credentials`, next: "Not set up" },
    { file: `components/${app}Settings.tsx`, old: "The credentials do not match the saved app identity.", next: "The keys do not match the saved app identity." },
    { file: `components/${app}Settings.tsx`, old: "Credentials saved. Pairing has not started.", next: "Keys saved. Pairing has not started." },
    { file: `components/${app}Settings.tsx`, old: "1. Save credentials securely", next: "1. Save your app keys" },
    { file: `components/${app}Settings.tsx`, old: "Save credentials", next: "Save keys" },
    { file: `components/${app}Settings.tsx`, old: "Open Channels in Murage Desktop to save credentials.", next: "Saving keys needs the Murage desktop app." },
    { file: `components/${app}Settings.tsx`, old: "Revoke this connection before changing its credentials or owner.", next: "Revoke this connection before changing its keys or owner." },
    { file: `components/${app}Settings.tsx`, old: "Saving credentials does not start pairing.", next: "Saving keys does not start pairing." },
    { file: `components/${app}Settings.tsx`, old: "Saved credentials are unchanged.", next: "Saved keys are unchanged." },
  ]),
  { file: "components/DiscordSettings.tsx", old: "Discord rejected the Gateway session.", next: "Discord rejected the connection." },
  { file: "lib/telegram-status.ts", old: "No token saved", next: "Not set up" },
  { file: "components/backups-section-ui.ts", old: "The SFTP server's identity changed since you trusted it.", next: "The off-site server's identity changed since you trusted it." },
  { file: "components/backups-section-ui.ts", old: "The SFTP server did not accept Murage's key.", next: "The off-site server did not accept Murage's key." },
  { file: "components/BackupRemoteSettings.tsx", old: "No eligible Murage backups were found in this repository.", next: "No usable Murage backups were found in this off-site copy." },
  { file: "components/BackupRemoteSettings.tsx", old: "Some repository entries could not be identified as eligible Murage backups and are not shown.", next: "Some items could not be recognized as usable Murage backups and are not shown." },
  { file: "components/BackupRemoteSettings.tsx", old: "created the backup repository in this folder", next: "created the off-site copy in this folder" },
  { file: "components/BackupRemoteSettings.tsx", old: "connected to the existing backup repository", next: "connected to the existing off-site copy" },
  { file: "components/CompanionSection.tsx", old: "Access URL", next: "Murage address" },
  { file: "components/CompanionSection.tsx", old: "Copy access URL", next: "Copy address" },
  { file: "components/CompanionSection.tsx", old: "No address yet; the door is starting, or Tailscale is not up on this computer.", next: "No address yet. Murage is starting, or Tailscale is not running on this computer." },
];
const SIMPLE_ONLY_OLD: string[] = [
  "Open the browser door", "Get the address", "Reach it from anywhere",
  "Off. Your tailnet needs HTTPS turned on first. The steps are below.", KEEP_AWAKE_DETAIL, PREVIEW_COPY.phoneTools.body, CLOSED_JOB_MOVED_REASON,
];

describe("nothing lost, one name (S4b, B3)", () => {
  it("every moved sentence is still in its component file", () => {
    for (const entry of MOVED) expect(source(entry.file), `${entry.file}: ${entry.old}`).toContain(entry.old.replace(/\s+/g, " "));
  });
  it("every renamed term is gone from its file and the new text is there (both modes, one name)", () => {
    for (const entry of RENAMED_BOTH) {
      const file = source(entry.file);
      expect(file, `${entry.file} still has: ${entry.old}`).not.toContain(entry.old);
      expect(file, `${entry.file} lacks: ${entry.next}`).toContain(entry.next!);
    }
  });
  it("the renamed lists share nothing with the moved or Simple-only lists", () => {
    const renamed = RENAMED_BOTH.map((entry) => entry.old);
    const others = [...MOVED.map((entry) => entry.old), ...SIMPLE_ONLY_OLD];
    for (const old of renamed) for (const other of others) {
      expect(other.includes(old) || old.includes(other), `${old} overlaps ${other}`).toBe(false);
    }
  });
});
