import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CallAvatar } from "./CallAvatar";
const bot = { name: "Ada", color: "green" as const, avatarCrop: "circle" as const, avatarUrl: "/api/attachments/portrait.png" };
it("the aura's shimmer is the waiting indicator: no circle ring around a square or a sprite", () => {
  for (const phase of ["sending", "working", "listening", "speaking"] as const) {
    const html = renderToStaticMarkup(createElement(CallAvatar, { bot, phase }));
    expect(html).not.toContain('data-testid="call-waiting-ring"');
    expect(html).toContain(`data-call-aura="${phase === "sending" ? "thinking" : phase}"`);
    expect(html).toContain('src="/api/attachments/portrait.png"'); expect(html).not.toContain("Connected");
  }
});
it("keeps unsafe or absent avatar data on the existing mascot fallback", () => {
  for (const avatarUrl of [undefined, "https://untrusted.invalid/avatar.png"]) {
    const html = renderToStaticMarkup(createElement(CallAvatar, { bot: { ...bot, avatarUrl }, phase: "working" })); expect(html).not.toContain("<img"); expect(html).not.toContain("untrusted.invalid"); expect(html).toContain("Ada");
  }
});
it("renders idle, with the held aura, while the call is on hold", () => {
  const html = renderToStaticMarkup(createElement(CallAvatar, { bot, phase: "working", held: true }));
  expect(html).toContain('data-call-aura="held"');
  expect(html).toContain('data-call-held="true"');
});
it("wears the aura: full for a custom image, soft for the mascot, in the phase the call is in", () => {
  const image = renderToStaticMarkup(createElement(CallAvatar, { bot, phase: "listening" }));
  expect(image).toContain('data-call-aura="listening"');
  expect(image).toContain('data-aura-variant="full"');
  expect(image).toContain('aria-hidden="true"');
  const mascot = renderToStaticMarkup(createElement(CallAvatar, { bot: { ...bot, avatarCrop: "mascot" }, phase: "listening" }));
  expect(mascot).toContain('data-aura-variant="soft"');
  expect(renderToStaticMarkup(createElement(CallAvatar, { bot, phase: "working", held: true }))).toContain('data-call-aura="held"');
  expect(renderToStaticMarkup(createElement(CallAvatar, { bot, phase: "listening", muted: true }))).toContain('data-call-aura="muted"');
  expect(renderToStaticMarkup(createElement(CallAvatar, { bot, phase: "listening", connecting: true }))).toContain('data-call-aura="connecting"');
  expect(renderToStaticMarkup(createElement(CallAvatar, { bot, phase: "speaking", lost: true }))).toContain('data-call-aura="reconnecting"');
  expect(renderToStaticMarkup(createElement(CallAvatar, { bot, phase: "sending" }))).toContain('data-call-aura="thinking"');
});
