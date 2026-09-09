import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CommAvatar } from "./CommAvatar";
const comm = { groupId: "room", withBotId: "sender", withName: "Sable", withColor: "blue" as const };
const sender = { id: "sender", name: "Renamed Sable", color: "blue" as const, avatarCrop: "circle" as const, avatarUrl: "/api/attachments/sender.png" };
const recipient = { ...sender, id: "recipient", name: "Sable", avatarUrl: "/api/attachments/recipient.png" };
it("uses the stable peer identity even after rename or a duplicate name", () => {
  const html = renderToStaticMarkup(createElement(CommAvatar, { comm, bots: [recipient, sender] }));
  expect(html).toContain('src="/api/attachments/sender.png"'); expect(html).not.toContain("recipient.png"); expect(html).toContain("Renamed Sable avatar");
});
it("falls back for missing or deleted peers without borrowing recipient image", () => {
  const html = renderToStaticMarkup(createElement(CommAvatar, { comm, bots: [recipient] }));
  expect(html).not.toContain("<img"); expect(html).toContain("Sable");
});
it("reuses safe avatar validation and explicit mascot choice", () => {
  for (const bot of [{ ...sender, avatarUrl: "https://untrusted.invalid/pixel.png" }, { ...sender, avatarCrop: "mascot" as const }]) {
    const html = renderToStaticMarkup(createElement(CommAvatar, { comm, bots: [bot] })); expect(html).not.toContain("<img"); expect(html).not.toContain("untrusted.invalid");
  }
});
