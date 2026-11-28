// SPDX-License-Identifier: AGPL-3.0-or-later
// CHROME-RESUME-FROM-APP (1.0.23, row CR): W15 (the button) and W16 (the copy).
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { BrowserExtensionPanelView, type BrowserExtensionPanelStatus } from "./BrowserExtensionPanel";
import { BROWSER_EXTENSION_PAUSED_REASON } from "../../shared/browser-unavailable";

const en = JSON.parse(readFileSync(new URL("../locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
const binding = { bindingId: "binding", botId: "bot", threadId: "thread", profileId: "profile_one", state: "paused" as const, generation: 7, sites: {} };
const status = (over: Partial<BrowserExtensionPanelStatus> = {}, bind: Record<string, unknown> = {}, profile: Record<string, unknown> = {}): BrowserExtensionPanelStatus => ({
  profiles: [{ profileId: "profile_one", browser: "Chrome", extensionVersion: "1.0.2", capabilities: ["app_resume_v1"], ...profile }],
  bindings: [{ ...binding, ...bind }], helper: { running: true }, storeUrl: null, canResumeHere: true, ...over });
const props = (s: BrowserExtensionPanelStatus) => ({ botName: "Mira", profileId: "profile_one", status: s, pending: false, error: "", connectBrowser: "chrome" as const, onConnectBrowser: vi.fn(), onCheck: vi.fn(), onProfile: vi.fn(), onAction: vi.fn(), onResume: vi.fn(), onSite: vi.fn(), onOwnBrowser: vi.fn() });
const html = (s: BrowserExtensionPanelStatus) => renderToStaticMarkup(createElement(BrowserExtensionPanelView, props(s)));
function find(node: ReactNode, predicate: (props: Record<string, any>) => boolean): Record<string, any> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } return; }
  if (!isValidElement(node)) return; const p = node.props as Record<string, any>; if (predicate(p)) return p; return find(p.children, predicate);
}

describe("W15: the Resume button", () => {
  it("shows for a plain pause on an online profile with app_resume_v1 on the desktop, and posts the generation shown", () => {
    const p = props(status());
    expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView, p))).toContain('data-action="resume"');
    find(BrowserExtensionPanelView(p), item => item["data-action"] === "resume")!.onClick();
    expect(p.onResume).toHaveBeenCalledWith("binding", 7);
  });
  it.each([
    ["a hand-over", status({}, { handoff: true, pausedReason: "handoff" })],
    ["a stopped task", status({}, { state: "stopped" })],
    ["an active task", status({}, { state: "active" })],
    ["an offline profile", status({ profiles: [] })],
    ["a request that is not the desktop", status({ canResumeHere: false })],
    ["an extension without the capability", status({}, {}, { capabilities: [] })],
  ])("is hidden for %s", (_name, s) => { expect(html(s)).not.toContain('data-action="resume"'); });
  it("shows the uncertain hint beside the button for outcomeUnknown and for an uncertain pause", () => {
    expect(html(status({}, { outcomeUnknown: true }))).toContain(en["browserExt.resume.uncertainHint"]);
    expect(html(status({}, { pausedReason: "uncertain" }))).toContain(en["browserExt.resume.uncertainHint"]);
    expect(html(status())).not.toContain(en["browserExt.resume.uncertainHint"]);
  });
  it("shows exactly one update line when the capability is missing, even for a very old extension", () => {
    const old = html(status({}, {}, { capabilities: [], extensionVersion: "1.0.0" }));
    expect(old).toContain(en["browserExt.updateToResumeApp"]);
    expect(old).not.toContain(en["browserExt.updateToResume"]);
    expect(html(status())).not.toContain(en["browserExt.updateToResumeApp"]);
  });
  it("is disabled while an action is pending", () => {
    expect(find(BrowserExtensionPanelView({ ...props(status()), pending: true }), item => item["data-action"] === "resume")?.disabled).toBe(true);
  });
});

describe("W16: the copy names the app's Resume", () => {
  it("the connection-lost line, the owner chat line and the bot refusals say Resume here or in the side panel", () => {
    expect(en["browserExt.state.connectionLost"]).toMatch(/press Resume here or in the Murage side panel/);
    const source = readFileSync(new URL("../../server/browser-extension-integration.ts", import.meta.url), "utf8");
    expect(source).toContain("press Resume in Murage or in the Murage for Chrome side panel");
    expect(source).not.toMatch(/press Resume in the Murage side panel/);
    expect(BROWSER_EXTENSION_PAUSED_REASON).toMatch(/Resume in Murage or in the Murage for Chrome side panel/);
    expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView, props(status({}, { state: "stopped" }))))).toContain("Resume here or in the side panel after checking the page");
  });
});
