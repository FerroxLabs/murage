// F5-T2: one image surface. The renderer suite runs in node with no DOM, so
// this file pins the pure decisions (what may load, identity, keyboard
// navigation) and the closed-state markup. Opening, focus, Escape, fit and
// "no request" are proved in a real browser by
// src/e2e/media-lightbox.human.spec.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  artifactImageItem,
  attachmentImageItem,
  ImageGallery,
  ImageMedia,
  imageSourceLabel,
  isRasterDataUrl,
  MarkdownImage,
  nextLightboxIndex,
  resolveMarkdownImage,
  ScreenFrameMedia,
  screenFrameItem,
  ArtifactImageMedia,
} from "./ImageMedia";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG}`;

describe("what a Markdown image may become", () => {
  it("renders the attachment server's own URL form and embedded raster bytes inline", () => {
    expect(resolveMarkdownImage("/api/attachments/abc-123.png", "chart")).toMatchObject({
      kind: "inline", item: { src: "/api/attachments/abc-123.png", alt: "chart", name: "chart", source: "attachment", download: true },
    });
    expect(resolveMarkdownImage(PNG_URL, "")).toMatchObject({
      kind: "inline", item: { src: PNG_URL, alt: "", name: "Image", source: "inline-data" },
    });
  });

  it("never fetches a local-looking path, even one whose filename matches a generated attachment", () => {
    for (const src of [
      "/Users/sean/private/abc-123.png",
      "C:\\Users\\sean\\abc-123.png",
      "file:///Users/sean/abc-123.png",
      "abc-123.png",
      "./abc-123.png",
      "/api/attachments/../secret.png",
      "/api/attachments/abc-123.svg",
      "/api/attachments/abc_123.png?x=1",
      "blob:http://127.0.0.1/abc",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:text/html;base64,PGgxPg==",
      "javascript:alert(1)",
      "",
      undefined,
    ]) {
      expect(resolveMarkdownImage(src, "x").kind, String(src)).toBe("local");
    }
  });

  it("holds a remote image as an external card that names its host", () => {
    expect(resolveMarkdownImage("https://tracker.example:8443/p.gif?u=1", "pixel")).toEqual({
      kind: "external", url: "https://tracker.example:8443/p.gif?u=1", host: "tracker.example:8443", alt: "pixel",
    });
    expect(resolveMarkdownImage("HTTP://Example.com/a.png", undefined)).toMatchObject({ kind: "external", host: "example.com" });
  });

  it("accepts raster data URLs only", () => {
    expect(isRasterDataUrl(PNG_URL)).toBe(true);
    expect(isRasterDataUrl("data:image/webp;base64,UklGRg==")).toBe(true);
    expect(isRasterDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isRasterDataUrl("data:image/png;base64,<script>")).toBe(false);
    expect(isRasterDataUrl(undefined)).toBe(false);
  });
});

describe("item builders", () => {
  it("maps only generated attachment names and keeps duplicates distinct by position", () => {
    expect(attachmentImageItem("/Users/x/attachments/abc-1.png", "abc-1.png", 0)).toMatchObject({
      src: "/api/attachments/abc-1.png", source: "attachment", download: true,
    });
    const a = attachmentImageItem("/a/abc-1.png", "abc-1.png", 0)!, b = attachmentImageItem("/a/abc-1.png", "abc-1.png", 1)!;
    expect(a.id).not.toBe(b.id);
    expect(attachmentImageItem("/a/evil.svg", "evil.svg")).toBeNull();
    expect(attachmentImageItem("/a/has space.png", "has space.png")).toBeNull();
  });

  it("previews a saved copy from its pinned bytes and changes identity with the digest", () => {
    const artifact = { id: "art-1", name: "Chart", sha256: "aa" };
    const item = artifactImageItem(artifact, PNG_URL)!;
    expect(item).toMatchObject({ src: PNG_URL, name: "Chart", source: "artifact", download: true });
    expect(artifactImageItem({ ...artifact, sha256: "bb" }, PNG_URL)!.id).not.toBe(item.id);
    expect(artifactImageItem(artifact, "data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(artifactImageItem(artifact, undefined)).toBeNull();
  });

  it("shows a screen frame's exact delivered bytes, offers no download and sanitizes the type", () => {
    const frame = screenFrameItem(PNG, "image/jpeg");
    expect(frame).toMatchObject({ src: `data:image/jpeg;base64,${PNG}`, source: "screen-frame", download: false, alt: "Bot's screen" });
    expect(screenFrameItem(PNG, "text/html").src.startsWith("data:image/png;base64,")).toBe(true);
    expect(screenFrameItem(PNG).id).not.toBe(screenFrameItem(PNG.replace("AAAA", "BBBB")).id);
  });

  // F5-T4 (IMG-SEED): which images carry a "Use as reference" source at all.
  // Only an image the harness can re-read by identity does; a screen frame, an
  // external URL and bytes that exist only in the message text never do.
  it("carries a reference source only for images the harness can re-read by identity", () => {
    expect(attachmentImageItem("/a/abc-1.png", "abc-1.png")!.reference).toEqual({ source: { kind: "attachment", attachmentId: "abc-1.png" } });
    expect(screenFrameItem(PNG).reference).toBeUndefined();
    // Markdown text is not authority, so neither Markdown form offers it.
    for (const src of [PNG_URL, "/api/attachments/abc-1.png"]) {
      const resolved = resolveMarkdownImage(src, "x");
      expect(resolved.kind, src).toBe("inline");
      expect(resolved.kind === "inline" && resolved.item.reference, src).toBeUndefined();
    }
  });

  it("pins a saved image to the exact version shown and offers nothing it cannot pin", () => {
    const saved = { id: "art-1", name: "Chart", sha256: "aa", mime: "image/png", bytes: 1024, threadId: "thread-a", botId: "bot-a" };
    expect(artifactImageItem(saved, PNG_URL)!.reference).toEqual({
      source: { kind: "artifact", artifactId: "art-1", sha256: "aa" }, threadId: "thread-a", botId: "bot-a",
    });
    // No conversation, an unusable type, or over the per-image limit: no action.
    expect(artifactImageItem({ ...saved, threadId: undefined }, PNG_URL)!.reference).toBeUndefined();
    expect(artifactImageItem({ ...saved, mime: "image/gif" }, PNG_URL)!.reference).toBeUndefined();
    expect(artifactImageItem({ ...saved, bytes: 11 * 1024 * 1024 }, PNG_URL)!.reference).toBeUndefined();
    expect(artifactImageItem({ id: "art-1", name: "Chart", sha256: "aa" }, PNG_URL)!.reference).toBeUndefined();
  });

  it("labels every source for the dialog", () => {
    for (const source of ["attachment", "artifact", "screen-frame", "external-link", "inline-data"] as const) {
      expect(imageSourceLabel(source)).toMatch(/\S/);
    }
    expect(imageSourceLabel("screen-frame")).toContain("Not saved");
  });
});

describe("keyboard navigation stays inside the set", () => {
  it("wraps arrows and jumps with Home/End", () => {
    expect(nextLightboxIndex(0, 3, "ArrowRight")).toBe(1);
    expect(nextLightboxIndex(2, 3, "ArrowRight")).toBe(0);
    expect(nextLightboxIndex(0, 3, "ArrowLeft")).toBe(2);
    expect(nextLightboxIndex(1, 3, "Home")).toBe(0);
    expect(nextLightboxIndex(1, 3, "End")).toBe(2);
    expect(nextLightboxIndex(0, 3, "Home")).toBeNull();
    expect(nextLightboxIndex(0, 3, "Enter")).toBeNull();
    expect(nextLightboxIndex(0, 1, "ArrowRight")).toBeNull();
  });
});

describe("closed-state markup", () => {
  it("renders an accessible enlarge button around the exact image, with reduced-motion fallbacks", () => {
    const item = attachmentImageItem("/a/abc-1.png", "abc-1.png")!;
    const html = renderToStaticMarkup(createElement(ImageMedia, { item }));
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="Enlarge image abc-1.png"');
    expect(html).toContain('src="/api/attachments/abc-1.png"');
    expect(html).toContain('alt="abc-1.png"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("motion-reduce:transition-none");
    expect(html).not.toContain("<dialog");
  });

  it("renders a gallery of thumbnails with one label per image and no open dialog", () => {
    const items = ["/a/abc-1.png", "/a/abc-2.png"].map((path, index) => attachmentImageItem(path, path.slice(3), index)!);
    const html = renderToStaticMarkup(createElement(ImageGallery, { items, label: (item) => `Open ${item.name}` }));
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Open abc-1.png"');
    expect(html).toContain('aria-label="Open abc-2.png"');
    expect(html).not.toContain("<dialog");
  });

  it("renders a screen frame and a saved image through the same thumbnail", () => {
    const frame = renderToStaticMarkup(createElement(ScreenFrameMedia, { png: PNG }));
    expect(frame).toContain('aria-label="Enlarge the bot&#x27;s screen"');
    expect(frame).toContain('data-image-media="screen-frame"');
    expect(frame).toContain(`src="${PNG_URL}"`);
    const saved = renderToStaticMarkup(createElement(ArtifactImageMedia, { artifact: { id: "a", name: "Chart", sha256: "s" }, content: PNG_URL }));
    expect(saved).toContain('data-image-media="artifact"');
    const unsafe = renderToStaticMarkup(createElement(ArtifactImageMedia, { artifact: { id: "a", name: "Chart", sha256: "s" }, content: "data:image/svg+xml;base64,PHN2Zz4=" }));
    expect(unsafe).not.toContain("<img");
    expect(unsafe).toContain("cannot be previewed");
  });

  it("keeps an external image as a card with no request until asked, and a local path as text", () => {
    const external = renderToStaticMarkup(createElement(MarkdownImage, { src: "https://tracker.example/p.gif", alt: "pixel" }));
    expect(external).not.toContain("<img");
    expect(external).not.toContain("tracker.example/p.gif");
    expect(external).toContain("Image from tracker.example not loaded.");
    expect(external).toContain(">Load image</button>");
    const local = renderToStaticMarkup(createElement(MarkdownImage, { src: "/Users/sean/secret.png", alt: "secret" }));
    expect(local).not.toContain("<img");
    expect(local).not.toContain("/Users/sean");
    expect(local).toContain("Local image paths are not loaded in chat.");
  });
});
