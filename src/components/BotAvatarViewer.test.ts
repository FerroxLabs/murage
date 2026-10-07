// Click an avatar image to see it larger. The mascot has nothing larger to
// show, so only an image avatar is a control. The dialog itself is the shared
// ImageLightbox (Esc, outside click, close button, Tab trap, focus return),
// which ImageMedia.test.ts covers; this file pins what is specific to avatars.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { en } from "@/locales";
import { ViewableBotAvatar, avatarLightboxItem } from "./BotAvatarViewer";

const moss = { name: "Moss", color: "green" as const };
const withImage = { ...moss, avatarUrl: "/api/attachments/abc-123.png", avatarCrop: "circle" as const };
const html = (bot: Parameters<typeof ViewableBotAvatar>[0]["bot"]) =>
  renderToStaticMarkup(createElement(ViewableBotAvatar, { bot, size: 112, animated: false }));
const source = readFileSync(fileURLToPath(new URL("./BotAvatarViewer.tsx", import.meta.url)), "utf8");

describe("ViewableBotAvatar", () => {
  it("makes an image avatar a keyboard-reachable button with an accessible label", () => {
    const markup = html(withImage);
    expect(markup).toMatch(/<button type="button"/);
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain(`aria-label="${en["avatar.viewLarger"]}"`);
    expect(markup).toContain("<img");
    // a native button: Enter and Space click it, no key handler to get wrong
    expect(source).not.toContain("onKeyDown");
    expect(markup).not.toContain("tabindex");
  });

  it("leaves the mascot alone: no button, nothing to open", () => {
    expect(html(moss)).not.toContain("<button");
    expect(html({ ...moss, avatarCrop: "mascot" })).not.toContain("<button");
    // a shape chosen with no image still shows the mascot
    expect(html({ ...moss, avatarCrop: "circle" })).not.toContain("<button");
    // an image kept while the crop is Mascot is not shown, so it is not viewable
    expect(html({ ...withImage, avatarCrop: "mascot" })).not.toContain("<button");
  });

  it("opens the full image in the shared lightbox and sends focus back to the avatar", () => {
    expect(source).toContain("ImageLightbox");
    expect(source).toMatch(/onClose=\{\(\) => setOpen\(false\)\}|onClose=\{close\}/);
    // the opener is focused explicitly: Safari does not focus a clicked button
    expect(source).toContain(".focus()");
    expect(source).not.toContain("Escape");
  });

  it("shows the stored image itself, not a thumbnail, with no download or reference action", () => {
    const item = avatarLightboxItem(withImage);
    expect(item).toMatchObject({ src: withImage.avatarUrl, source: "avatar", download: false });
    expect(item.name).toBe("Moss");
    expect(item.reference).toBeUndefined();
  });
});

describe("avatar copy", () => {
  it("has every new string in all eight locales, with no em dash and no safety words", async () => {
    const keys = ["avatar.viewLarger", "media.source.avatar", "settings.appearance.title"] as const;
    for (const code of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      const pack = code === "en" ? en : (await import(`../locales/${code}.json`)).default;
      for (const key of keys) {
        expect(pack[key], `${code} ${key}`).toBeTruthy();
        expect(pack[key]).not.toContain("—");
        expect(String(pack[key])).not.toMatch(/\b(safe|safely|safety|unsafe)\b/i);
      }
    }
  });
});
