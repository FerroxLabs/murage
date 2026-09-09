import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CallAvatar } from "./CallAvatar";
const bot = { name: "Ada", color: "green" as const, avatarCrop: "circle" as const, avatarUrl: "/api/attachments/portrait.png" };
it("shows a waiting indicator only for real sending or working phases", () => {
  for (const phase of ["sending", "working", "listening", "speaking"] as const) {
    const html = renderToStaticMarkup(createElement(CallAvatar, { bot, phase }));
    expect(html.includes('data-testid="call-waiting-ring"')).toBe(phase === "sending" || phase === "working");
    expect(html).toContain('src="/api/attachments/portrait.png"'); expect(html).not.toContain("Connected");
  }
});
it("keeps unsafe or absent avatar data on the existing mascot fallback", () => {
  for (const avatarUrl of [undefined, "https://untrusted.invalid/avatar.png"]) {
    const html = renderToStaticMarkup(createElement(CallAvatar, { bot: { ...bot, avatarUrl }, phase: "working" })); expect(html).not.toContain("<img"); expect(html).not.toContain("untrusted.invalid"); expect(html).toContain("Ada");
  }
});
