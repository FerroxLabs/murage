// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { McpSignInCardData, Message } from "@/state/store";
import { dismissSignInCard, McpSignInCard } from "./McpSignInCard";

afterEach(() => { vi.unstubAllGlobals(); return setLocale("en"); });

const data = (more: Partial<McpSignInCardData> = {}): McpSignInCardData => ({
  name: "comfy", host: "cloud.comfy.org", bot: "Sable", reason: "sign-in-ended", status: "required", resumeKey: "mcp-abc",
  title: "Sign in to cloud.comfy.org", body: "comfy needs you to sign in again before Sable can use it.", phone: "Finish sign-in on the computer running Murage.", ...more,
});
const render = (card: McpSignInCardData) =>
  renderToStaticMarkup(createElement(McpSignInCard, { botId: "b1", threadId: "t1", message: { id: "m1", role: "bot", kind: "mcpSignIn", at: 1, mcpSignIn: card } as unknown as Message }));
const onDesktop = () => vi.stubGlobal("window", { muragebox: { mcpServers: { signIn: async () => ({ ok: true }) } } });
const onPhone = () => vi.stubGlobal("window", {});

describe("the mid-turn sign-in card", () => {
  it("offers a Sign in button on the desktop, with the host and the bot named", () => {
    onDesktop();
    const html = render(data());
    expect(html).toContain("Sign in to cloud.comfy.org");
    expect(html).toContain("comfy needs you to sign in again before Sable can use it.");
    expect(html).toMatch(/<button[^>]*>(?:<svg[^>]*>.*?<\/svg>)? ?Sign in<\/button>/);
    expect(html).not.toContain("Finish sign-in on the computer running Murage.");
  });

  it("tells a phone or the browser door where to finish, and offers no button that could not work", () => {
    onPhone();
    const html = render(data());
    expect(html).toContain("Finish sign-in on the computer running Murage.");
    expect(html).not.toMatch(/>\s*Sign in<\/button>/);
    expect(html).toContain("Sign in to cloud.comfy.org");
  });

  it("shows that the task is carrying on once signed in, without a button", () => {
    onDesktop();
    const html = render(data({ status: "signed-in", resumed: true }));
    expect(html).toContain("Signed in. Sable is continuing the task.");
    expect(html).not.toMatch(/>\s*Sign in<\/button>/);
  });

  it("shows a failure plainly and leaves nothing when dismissed", () => {
    onDesktop();
    expect(render(data({ error: "The server could not be reached." }))).toContain("The server could not be reached.");
    expect(render(data({ dismissed: true }))).toBe("");
  });

  it("follows the chosen language, and the desktop button fits a phone-width screen", async () => {
    onDesktop();
    await setLocale("de");
    const html = render(data());
    expect(html).toContain("Bei cloud.comfy.org anmelden");
    expect(html).toContain("min-h-[44px] w-full");
  });

  it("carries no token, only names", () => {
    onDesktop();
    expect(render(data())).not.toMatch(/at_|Bearer|token/i);
  });

  it("dismissing from the browser door says so when the computer's route refuses, instead of failing silently (review L8)", async () => {
    const refused = vi.fn().mockRejectedValue(new Error("no route"));
    expect(await dismissSignInCard(refused, "/api/bots/b1/mcp-sign-in-cards/m1", "t1")).toBe("Close this card on the computer running Murage.");
    const ok = vi.fn().mockResolvedValue({ dismissed: true });
    expect(await dismissSignInCard(ok, "/api/bots/b1/mcp-sign-in-cards/m1", "t1")).toBeNull();
    expect(ok).toHaveBeenCalledWith("/api/bots/b1/mcp-sign-in-cards/m1/dismiss", { method: "POST", body: JSON.stringify({ threadId: "t1" }) });
  });
});
