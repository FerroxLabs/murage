// INLINE1: a "Saved file" card in the chat shows the thing itself — the
// image, the player, the first part of the document — instead of a Preview
// button that leaves for the Files section.
//
// The renderer suite runs in node with no DOM, so this file pins the pure
// rules (which kind embeds what, how text is bounded, which resolver answers
// are allowed to become a src), the first paint of each card state, and the
// wiring the browser proof depends on. Loading through the capability route,
// the lightbox opening in place and the player are proved in a browser by
// src/e2e/artifact-cards.human.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_INLINE_COLLAPSED_CHARS,
  ARTIFACT_INLINE_EXPANDED_CHARS,
  acceptedArtifactMedia,
  artifactCodeLanguage,
  artifactInlineKind,
  artifactMediaImageItem,
  artifactTextSlice,
  InlineArtifactCard,
} from "./ArtifactCards";
import { ArtifactCard } from "./Files";
import type { Artifact } from "../../shared/artifacts";
import type { MediaAsset, MediaResolveResponse } from "../../shared/media-assets";

const cards = readFileSync(fileURLToPath(new URL("./ArtifactCards.tsx", import.meta.url)), "utf8");
const files = readFileSync(fileURLToPath(new URL("./Files.tsx", import.meta.url)), "utf8");

const base: Artifact = {
  id: "8b3f7a54-1b0e-4c3d-9d7a-2f6e1c0b9a11", name: "Weekly report", filename: "weekly-report.md", kind: "text", mime: "text/plain", bytes: 2_048,
  sha256: "a".repeat(64), createdAt: 1_757_000_000_000, botId: "research", botName: "Research bot", threadId: "task-7", relativePath: "outputs/weekly-report.md",
  sourceState: "current", savedState: "available", sourceConversationAvailable: true,
};
const artifact = (overrides: Partial<Artifact>): Artifact => ({ ...base, ...overrides });

const CAP = "mc1." + "A".repeat(24) + "." + "B".repeat(43);
const ASSET_ID = "ma1_" + "C".repeat(32);
const readyAsset: MediaAsset = {
  id: ASSET_ID, scope: { serverId: "local", botId: "research", threadId: "task-7" }, source: "artifact", kind: "image", name: "chart.png", mime: "image/png",
  bytes: 4_096, revision: "a".repeat(64), width: 800, height: 600, availability: "ready",
  capabilities: { preview: true, download: true, open: false, reveal: false, imageReference: true },
};
const ready: MediaResolveResponse = { asset: readyAsset, url: `/api/media/bytes/${ASSET_ID}?cap=${CAP}`, expiresAt: 1_757_000_600_000 };

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

describe("what each saved version embeds", () => {
  it("decides from the registered kind and name, never from bytes", () => {
    expect(artifactInlineKind(artifact({ kind: "image", filename: "chart.png" }))).toBe("image");
    expect(artifactInlineKind(artifact({ kind: "html", filename: "report.html" }))).toBe("html");
    expect(artifactInlineKind(artifact({ kind: "text", filename: "notes.md" }))).toBe("markdown");
    expect(artifactInlineKind(artifact({ kind: "text", filename: "NOTES.MARKDOWN" }))).toBe("markdown");
    expect(artifactInlineKind(artifact({ kind: "text", filename: "data.json" }))).toBe("code");
    expect(artifactInlineKind(artifact({ kind: "text", filename: "run.log" }))).toBe("code");
    expect(artifactInlineKind(artifact({ kind: "other", filename: "narration.wav" }))).toBe("audio");
    expect(artifactInlineKind(artifact({ kind: "other", filename: "take.mp3" }))).toBe("audio");
    expect(artifactInlineKind(artifact({ kind: "other", filename: "demo.mp4" }))).toBe("video");
    expect(artifactInlineKind(artifact({ kind: "other", filename: "demo.webm" }))).toBe("video");
  });

  it("keeps today's buttons for everything else, and for a saved copy that is gone", () => {
    expect(artifactInlineKind(artifact({ kind: "other", filename: "deck.pdf" }))).toBe("none");
    expect(artifactInlineKind(artifact({ kind: "other", filename: "archive.zip" }))).toBe("none");
    expect(artifactInlineKind(artifact({ kind: "other", filename: "script.py" }))).toBe("none");
    expect(artifactInlineKind(artifact({ kind: "image", filename: "chart.png", savedState: "missing" }))).toBe("none");
    expect(artifactInlineKind(artifact({ kind: "text", filename: "notes.md", savedState: "unavailable" }))).toBe("none");
  });

  it("names the code language by extension", () => {
    expect(artifactCodeLanguage("data.json")).toBe("json");
    expect(artifactCodeLanguage("rows.CSV")).toBe("csv");
    expect(artifactCodeLanguage("notes.txt")).toBe("text");
    expect(artifactCodeLanguage("README")).toBe("text");
  });
});

describe("a document is bounded in the card", () => {
  const lines = Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(40)}`);
  const long = lines.join("\n");

  it("shows a short document whole, with nothing to expand", () => {
    expect(artifactTextSlice("# Title\n\nShort.", false)).toEqual({ text: "# Title\n\nShort.", truncated: false, expandable: false });
  });

  it("cuts the first slice on a line boundary and offers Show more", () => {
    const slice = artifactTextSlice(long, false);
    expect(slice.truncated).toBe(true);
    expect(slice.expandable).toBe(true);
    expect(slice.text.length).toBeLessThanOrEqual(ARTIFACT_INLINE_COLLAPSED_CHARS);
    expect(slice.text.length).toBeGreaterThan(ARTIFACT_INLINE_COLLAPSED_CHARS / 2);
    expect(long.charAt(slice.text.length)).toBe("\n");
    expect(slice.text.endsWith("x")).toBe(true);
  });

  it("expands to the ceiling and no further, and says so", () => {
    const expanded = artifactTextSlice(long, true);
    expect(expanded).toEqual({ text: long, truncated: false, expandable: false });
    const huge = "y".repeat(ARTIFACT_INLINE_EXPANDED_CHARS * 2);
    const capped = artifactTextSlice(huge, true);
    expect(capped.text.length).toBe(ARTIFACT_INLINE_EXPANDED_CHARS);
    expect(capped.truncated).toBe(true);
    expect(capped.expandable).toBe(false);
  });

  it("falls back to a hard cut when the only line break is too early", () => {
    const oneLine = "a\n" + "b".repeat(ARTIFACT_INLINE_COLLAPSED_CHARS * 3);
    expect(artifactTextSlice(oneLine, false).text.length).toBe(ARTIFACT_INLINE_COLLAPSED_CHARS);
  });
});

describe("no card fetches bytes without a capability", () => {
  it("accepts only a ready asset whose URL is this harness's byte route with a capability", () => {
    expect(acceptedArtifactMedia(ready)).toEqual({ asset: readyAsset, url: ready.url, expiresAt: ready.expiresAt });
    expect(acceptedArtifactMedia({ asset: readyAsset, url: ready.url })).toEqual({ asset: readyAsset, url: ready.url });
  });

  it("refuses every answer that is not that", () => {
    expect(acceptedArtifactMedia(undefined)).toBeNull();
    expect(acceptedArtifactMedia(null)).toBeNull();
    expect(acceptedArtifactMedia({ asset: readyAsset })).toBeNull();
    expect(acceptedArtifactMedia({ asset: { ...readyAsset, availability: "changed" }, url: ready.url })).toBeNull();
    expect(acceptedArtifactMedia({ asset: { ...readyAsset, availability: "unsupported" }, url: ready.url })).toBeNull();
    // the route without its capability, a forged short token, a data: URL,
    // the download route, another origin, a path
    expect(acceptedArtifactMedia({ asset: readyAsset, url: `/api/media/bytes/${ASSET_ID}` })).toBeNull();
    expect(acceptedArtifactMedia({ asset: readyAsset, url: `/api/media/bytes/${ASSET_ID}?cap=mc1.short.sig` })).toBeNull();
    expect(acceptedArtifactMedia({ asset: readyAsset, url: `/api/media/bytes/${ASSET_ID}?token=${CAP}` })).toBeNull();
    expect(acceptedArtifactMedia({ asset: readyAsset, url: "data:image/png;base64,iVBORw0KGgo=" })).toBeNull();
    expect(acceptedArtifactMedia({ asset: readyAsset, url: `/api/artifacts/${base.id}/download` })).toBeNull();
    expect(acceptedArtifactMedia({ asset: readyAsset, url: `http://127.0.0.1:8799/api/media/bytes/${ASSET_ID}?cap=${CAP}` })).toBeNull();
    expect(acceptedArtifactMedia({ asset: readyAsset, url: `//evil.example/api/media/bytes/${ASSET_ID}?cap=${CAP}` })).toBeNull();
    expect(acceptedArtifactMedia({ asset: readyAsset, url: "/Users/sean/desk/chart.png" })).toBeNull();
  });

  it("builds the image item from the capability URL, pinned to the digest, with the reference rule of the Files preview", () => {
    const png = artifact({ kind: "image", filename: "chart.png", mime: "image/png", bytes: 4_096, name: "Saved chart" });
    const item = artifactMediaImageItem(png, ready.url!);
    expect(item).toMatchObject({ id: `artifact:${png.id}:${png.sha256}`, src: ready.url, name: "Saved chart", alt: "Saved chart", source: "artifact", download: true });
    expect(item.reference).toEqual({ source: { kind: "artifact", artifactId: png.id, sha256: png.sha256 }, threadId: "task-7", botId: "research" });
    // GIF is not a reference format; the image still shows
    const gif = artifactMediaImageItem(artifact({ kind: "image", filename: "loop.gif", mime: "image/gif" }), ready.url!);
    expect(gif.src).toBe(ready.url);
    expect(gif.reference).toBeUndefined();
  });

  it("never composes a byte URL, a data: URL or the download route into a source itself", () => {
    // the only mention of the byte route is the acceptance check against the contract constant
    expect(cards.match(/MEDIA_ROUTES\.bytes/g)).toHaveLength(1);
    expect(cards).not.toContain("/api/media/bytes");
    expect(cards).not.toContain("data:image");
    expect(cards).not.toContain("/download");
    expect(cards).toContain('body: JSON.stringify({ ref: { source: "artifact", artifactId } })');
    expect(cards).toContain("const accepted = acceptedArtifactMedia(response);");
    expect(cards).toContain("acceptedArtifactMedia(await resolveArtifactMedia(artifact.id))");
  });
});

describe("the card's first paint", () => {
  const inline = createElement("div", { "data-testid": "the-thing" }, "the thing");

  it("shows the thing between the metadata and the buttons, and offers no Preview button", () => {
    const markup = render(createElement(ArtifactCard, { artifact: artifact({ kind: "image", filename: "chart.png", name: "Saved chart" }), inline, onDownload: () => {} }));
    expect(markup).toContain('data-artifact-inline-slot=""');
    expect(markup).toContain('data-testid="the-thing"');
    expect(markup.indexOf("the thing")).toBeGreaterThan(markup.indexOf("Saved copy"));
    expect(markup.indexOf("the thing")).toBeLessThan(markup.indexOf(">Download</button>"));
    expect(markup).not.toContain(">Preview</button>");
  });

  it("keeps Download, Open in app and Show in folder exactly as they were", () => {
    const markup = render(createElement(ArtifactCard, { artifact: artifact({ kind: "image", filename: "chart.png" }), inline, onDownload: () => {}, onNativeAction: () => {}, onOpenHere: () => {} }));
    expect(markup).toContain(">Download</button>");
    expect(markup).toContain(">Open in app</button>");
    expect(markup).toContain(">Show in folder</button>");
    expect(markup).toContain(">Open here</button>");
  });

  it("drops the 'Preview is unavailable' note once a player is embedded in an 'other' card", () => {
    const wav = artifact({ kind: "other", filename: "narration.wav", mime: "application/octet-stream" });
    expect(render(createElement(ArtifactCard, { artifact: wav, inline, onDownload: () => {} }))).not.toContain("Preview is unavailable for this format.");
    expect(render(createElement(ArtifactCard, { artifact: wav, onDownload: () => {} }))).toContain("Preview is unavailable for this format. Download to review it.");
  });

  it("offers Preview only when told to, with the note that says where it goes", () => {
    const html = artifact({ kind: "html", filename: "report.html" });
    const fallback = render(createElement(ArtifactCard, { artifact: html, onDownload: () => {}, onPreview: () => {}, inlineNote: "The preview could not be shown here. Preview opens it in Files." }));
    expect(fallback).toContain(">Preview</button>");
    expect(fallback).toContain("The preview could not be shown here. Preview opens it in Files.");
    expect(render(createElement(ArtifactCard, { artifact: html, onDownload: () => {} }))).not.toContain(">Preview</button>");
  });

  it("a chat card starts by saying it is loading, with no Preview button to flash", () => {
    for (const overrides of [
      { kind: "image" as const, filename: "chart.png" }, { kind: "html" as const, filename: "report.html" },
      { kind: "text" as const, filename: "notes.md" }, { kind: "text" as const, filename: "data.json" },
      { kind: "other" as const, filename: "narration.wav" }, { kind: "other" as const, filename: "demo.mp4" },
    ]) {
      const markup = render(createElement(InlineArtifactCard, { artifact: artifact(overrides), busy: false, onDownload: () => {}, onOpenHere: () => {} }));
      expect(markup, overrides.filename).toContain('data-artifact-inline="loading"');
      expect(markup, overrides.filename).toContain("Loading preview…");
      expect(markup, overrides.filename).not.toContain(">Preview</button>");
      expect(markup, overrides.filename).not.toContain("Preview is unavailable");
    }
  });

  it("a chat card for a format with no inline preview keeps today's buttons and note", () => {
    const pdf = render(createElement(InlineArtifactCard, { artifact: artifact({ kind: "other", filename: "deck.pdf" }), busy: false, onDownload: () => {}, onOpenHere: () => {} }));
    expect(pdf).not.toContain("data-artifact-inline=");
    expect(pdf).not.toContain(">Preview</button>");
    expect(pdf).toContain("Preview is unavailable for this format. Download to review it.");
    expect(pdf).toContain(">Download</button>");
    // a saved copy that is gone: the disabled Preview of today, no loading
    const gone = render(createElement(InlineArtifactCard, { artifact: artifact({ kind: "image", filename: "chart.png", savedState: "missing" }), busy: false, onDownload: () => {}, onOpenHere: () => {} }));
    expect(gone).not.toContain("Loading preview…");
    expect(gone).toContain('disabled="">Preview</button>');
    expect(gone).toContain("Saved copy is unavailable.");
  });
});

describe("wiring the browser proof depends on", () => {
  it("the chat card opens Files only as the fallback for a preview that could not be shown", () => {
    expect(cards).toContain('const previewFallback = inline.status === "failed" && (kind === "image" || kind === "html" || kind === "markdown" || kind === "code");');
    expect(cards).toContain('onPreview={previewFallback || (kind === "none" && artifact.kind !== "other") ? () => openFiles({ artifactId: artifact.id, botId: artifact.botId }) : undefined}');
    expect(cards.match(/openFiles\(/g)).toHaveLength(1);
  });

  it("the image opens the shared lightbox in place and the player is the F5-T3 card", () => {
    expect(cards).toContain("<ImageMedia item={inline.item}");
    expect(cards).toContain("<MediaPlayerCard key={`${inline.asset.id}:${inline.asset.revision ?? \"\"}`} asset={inline.asset} url={inline.url} expiresAt={inline.expiresAt} refresh={refresh} />");
    expect(cards).toContain("<MediaUnplayableCard asset={inline.asset} reason={unplayableMessage(inline.reason)} />");
  });

  it("text is rendered through ChatMarkdown or a code block, HTML through the same protected frame Files uses", () => {
    expect(cards).toContain("<ChatMarkdown text={slice.text} scope={scope} />");
    expect(cards).toContain("<CodeBlock code={slice.text} lang={artifactCodeLanguage(artifact.filename)} streaming={false} />");
    expect(cards).toContain('sandbox="" referrerPolicy="no-referrer" srcDoc={html}');
    expect(cards).toContain("const html = useMemo(() => artifactPreviewHtml(content), [content]);");
  });

  it("Open here still opens the working file in the pane by the identity the server registered", () => {
    expect(cards).toContain('dispatch({ type: "workspacePane", action: { type: "open", scope: { botId: artifact.botId, threadId: artifact.threadId }, relativePath: artifact.relativePath, mode: "preview" } })');
    expect(files).toContain('onOpenHere && artifact.sourceState === "current"');
  });

  it("the Files section's own preview is unchanged", () => {
    expect(files).toContain("onPreview={() => void act(async () => setPreview(await api(`/api/artifacts/${artifact.id}/preview`) as ArtifactPreview))}");
    expect(files).toContain('{preview.mode === "image" && <ArtifactImageMedia artifact={preview.artifact} content={preview.content} />}');
    expect(files).toContain('{onPreview && artifact.kind !== "other" && <button className={button} disabled={busy || !available} onClick={onPreview}>Preview</button>}');
  });
});
