// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B84: a custom avatar can be zoomed and repositioned, and the same framing
// shows everywhere the bot's picture appears.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BotAvatar } from "./Avatar";
import { AVATAR_FRAMING_RESET } from "./BotProfileAvatarCard";
import { avatarFraming, clampAvatarFocus, clampAvatarZoom } from "../../shared/bot-avatar";
import { parseBotProfilePatch } from "../../server/bot-profile";

const picture = { name: "Nova", color: "green" as const, avatarUrl: "/api/attachments/n1.webp", avatarCrop: "circle" as const };

describe("avatar framing", () => {
  it("clamps untrusted values and keeps the plain cover crop by default", () => {
    expect(clampAvatarZoom(9)).toBe(3);
    expect(clampAvatarZoom("2")).toBe(1);
    expect(clampAvatarFocus(-1)).toBe(0);
    expect(clampAvatarFocus(Number.NaN)).toBe(0.5);
    expect(avatarFraming({})).toEqual({ objectPosition: "50% 50%" });
    expect(avatarFraming({ avatarZoom: 2, avatarFocusX: 0.25, avatarFocusY: 1 })).toEqual({ objectPosition: "25% 100%", transform: "scale(2)", transformOrigin: "25% 100%" });
  });

  it("renders a zoomed picture clipped to its tile, at the chosen point", () => {
    const html = renderToStaticMarkup(createElement(BotAvatar, { bot: { ...picture, avatarZoom: 2, avatarFocusX: 0.2 }, size: 40 }));
    expect(html).toContain("data-avatar-zoomed");
    expect(html).toContain("scale(2)");
    expect(html).toContain("object-position:20% 50%");
  });

  it("leaves an unzoomed picture as it was, with no wrapper", () => {
    const html = renderToStaticMarkup(createElement(BotAvatar, { bot: picture, size: 40 }));
    expect(html).not.toContain("data-avatar-zoomed");
    expect(html).not.toContain("scale(");
  });

  it("the profile patch takes framing in range and refuses it out of range", () => {
    expect(parseBotProfilePatch({ avatarZoom: 1.5, avatarFocusX: 0, avatarFocusY: 1 }, true).ok).toBe(true);
    expect(parseBotProfilePatch({ avatarZoom: 4 }, true).ok).toBe(false);
    expect(parseBotProfilePatch({ avatarFocusX: 2 }, true).ok).toBe(false);
  });

  it("a new picture starts unzoomed and centred", () => {
    expect(AVATAR_FRAMING_RESET).toEqual({ avatarZoom: 1, avatarFocusX: 0.5, avatarFocusY: 0.5 });
  });
});
