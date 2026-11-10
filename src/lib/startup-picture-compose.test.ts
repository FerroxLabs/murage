// SPDX-License-Identifier: AGPL-3.0-or-later
// FIRSTRUN-1019 slice B: composing the cached picture (B2 to B8). The main-side validator is the real one from slice A.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PICTURE_MAX_BYTES, PICTURE_FILE, isInertSvg, validatePicture, writeStartupPicture } from "../../electron/startup-picture.mjs";
import { splashPage } from "../../electron/startup-splash.mjs";
import {
  PHOTO_PX,
  composeStartupPicture,
  downscalePhoto,
  fitWithin,
  photoFaceSvg,
  standaloneSvg,
  type ComposeInput,
} from "./startup-picture-compose";
import en from "../locales/startup-tips/en.json";

const MASCOT = (state: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" data-state="${state}"><circle cx="15" cy="15" r="10" fill="#ff6b35"/></svg>`;
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const bots = {
  chief: { id: "s", name: "Sable", color: "orange" as const },
  mates: [{ id: "n", name: "Nova", color: "blue" as const }, { id: "p", name: "Pepper", color: "green" as const }],
};
function input(extra: Partial<ComposeInput> = {}): ComposeInput {
  return {
    roster: bots as ComposeInput["roster"],
    language: "en",
    os: "mac",
    phoneAvailable: true,
    sessionTip: 3,
    loadStrings: async () => en,
    renderMascot: async (_bot, state) => MASCOT(state),
    loadPhoto: async () => null,
    now: () => 1_760_000_000_000,
    ...extra,
  };
}

describe("B1/B2 the composed picture is exactly what main accepts", () => {
  it("builds the picture for the next start: two faces of the Chief, the next tip in the Chief's words", async () => {
    const picture = await composeStartupPicture(input({ sessionTip: 3 }));
    expect(validatePicture(picture)).not.toBeNull();
    expect(picture).toMatchObject({ v: 1, tipNext: 4, at: 1_760_000_000_000, tip: { id: "needs" } });
    expect(picture!.faceA).toContain('data-state="idle"');
    expect(picture!.faceB).toContain('data-state="happy"');
  });

  it("rotates from the tip this start showed: 11 wraps to 0, no saved picture starts at the second tip", async () => {
    expect((await composeStartupPicture(input({ sessionTip: 11 })))!.tipNext).toBe(0);
    expect((await composeStartupPicture(input({ sessionTip: null })))!.tipNext).toBe(1);
  });

  it("skips the phone tip where phone pairing cannot work", async () => {
    expect((await composeStartupPicture(input({ sessionTip: 9, phoneAvailable: false })))!.tip.id).toBe("notify");
    expect((await composeStartupPicture(input({ sessionTip: 9, phoneAvailable: true })))!.tip.id).toBe("phone");
  });

  it("uses the pack of the app language, and nothing at all when there is no Chief", async () => {
    const loadStrings = vi.fn(async () => ({ ...en, "needs.head": "Freigaben warten an einem Ort" }));
    const picture = await composeStartupPicture(input({ language: "de", loadStrings }));
    expect(loadStrings).toHaveBeenCalledWith("de");
    expect(picture!.tip.head).toBe("Freigaben warten an einem Ort");
    expect(await composeStartupPicture(input({ roster: { chief: null, mates: [] } }))).toBeNull();
  });

  it("gives up (null, never a half picture) when a face cannot be drawn", async () => {
    expect(await composeStartupPicture(input({ renderMascot: async (_bot, state) => (state === "happy" ? null : MASCOT(state)) }))).toBeNull();
  });
});

describe("B6 an uploaded photo is embedded as a small data URI with its saved crop, zoom and focus", () => {
  it("fits a picture within 96 px and never scales one up", () => {
    expect(PHOTO_PX).toBe(96);
    expect(fitWithin(300, 150, 96)).toEqual({ width: 96, height: 48 });
    expect(fitWithin(150, 300, 96)).toEqual({ width: 48, height: 96 });
    expect(fitWithin(50, 40, 96)).toEqual({ width: 50, height: 40 });
  });

  it("draws the saved framing: cover crop at the focus point, then the zoom about that point, inside the chosen tile", () => {
    const svg = photoFaceSvg({ dataUri: PNG, width: 96, height: 48, crop: "circle", zoom: 2, focusX: 0.25, focusY: 0.75 });
    expect(isInertSvg(svg)).toBe(true);
    const image = svg.match(/<image[^>]*>/)![0];
    const num = (name: string) => Number(image.match(new RegExp(` ${name}="(-?[\\d.]+)"`))![1]);
    // tile 30: cover scale 0.625 gives 60 by 30; the focus 0.25 slides it left by (30 - 60) * 0.25
    expect([num("x"), num("y"), num("width"), num("height")]).toEqual([-7.5, 0, 60, 30]);
    expect(image).toContain(PNG);
    expect(svg).toMatch(/translate\(7\.5 22\.5\) scale\(2\) translate\(-7\.5 -22\.5\)/);
    expect(svg).toContain("<circle");
    expect(photoFaceSvg({ dataUri: PNG, width: 30, height: 30, crop: "square" })).not.toContain("scale(");
    expect(photoFaceSvg({ dataUri: PNG, width: 30, height: 30, crop: "rounded" })).toContain('rx="6.6"');
  });

  it("refuses a photo address that is not a stored attachment, without fetching it", async () => {
    const fetchImpl = vi.fn();
    for (const url of ["https://example.com/a.png", "/api/other/a.png", "data:image/png;base64,AAAA", "/api/attachments/../x.png"]) {
      expect(await downscalePhoto(url, { fetchImpl: fetchImpl as never, scale: async () => ({ dataUri: PNG, width: 1, height: 1 }) })).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("scales the fetched attachment to 96 px at most; a missing attachment is null", async () => {
    const scale = vi.fn(async (_blob: Blob, max: number) => ({ dataUri: PNG, width: max, height: max }));
    const ok = vi.fn(async () => new Response(new Blob(["x"], { type: "image/png" }), { status: 200 }));
    expect(await downscalePhoto("/api/attachments/abc-1.png", { fetchImpl: ok as never, scale })).toEqual({ dataUri: PNG, width: 96, height: 96 });
    expect(scale).toHaveBeenCalledWith(expect.any(Blob), 96);
    const gone = vi.fn(async () => new Response("", { status: 404 }));
    expect(await downscalePhoto("/api/attachments/abc-1.png", { fetchImpl: gone as never, scale })).toBeNull();
    const boom = vi.fn(async () => { throw new Error("offline"); });
    expect(await downscalePhoto("/api/attachments/abc-1.png", { fetchImpl: boom as never, scale })).toBeNull();
  });

  it("composes a photo Chief from the photo, and falls back to the mascot when the attachment is missing", async () => {
    const photoChief = { ...bots.chief, avatarUrl: "/api/attachments/abc-1.png", avatarCrop: "circle" as const, avatarZoom: 1.5, avatarFocusX: 0.4, avatarFocusY: 0.6 };
    const renderMascot = vi.fn(async (_bot: unknown, state: string) => MASCOT(state));
    const withPhoto = await composeStartupPicture(input({ roster: { ...bots, chief: photoChief } as never, renderMascot, loadPhoto: async () => ({ dataUri: PNG, width: 96, height: 96 }) }));
    expect(withPhoto!.faceA).toContain(PNG);
    expect(withPhoto!.faceA).toMatch(/scale\(1\.5\)/);
    // the Chief's own faces come from the photo; the mascot is drawn only for the teammates' row
    expect(renderMascot.mock.calls.filter(([bot]) => (bot as { name: string }).name === "Sable")).toHaveLength(0);
    const missing = await composeStartupPicture(input({ roster: { ...bots, chief: photoChief } as never, renderMascot, loadPhoto: async () => null }));
    expect(missing!.faceA).toContain('data-state="idle"');
    // a bot that chose the mascot shape never loads its old photo
    const loadPhoto = vi.fn(async () => ({ dataUri: PNG, width: 96, height: 96 }));
    await composeStartupPicture(input({ roster: { ...bots, chief: { ...photoChief, avatarCrop: "mascot" as const } } as never, loadPhoto }));
    expect(loadPhoto).not.toHaveBeenCalled();
  });
});

describe("B6b the saved face SVG is a standalone image and its ids do not collide", () => {
  const rendered = `<svg viewBox="0 0 30 30" class="x"><defs><linearGradient id="g"><stop offset="0"/></linearGradient><clipPath id="c"><path d="M0 0h30v30z"/></clipPath></defs><g clip-path="url(#c)"><path id="g2" fill="url(#g)" d="M0 0h30v30z"/></g><use href="#g2"/></svg>`;
  it("sets the namespace and gives every id a face prefix, references included", () => {
    const a = standaloneSvg(rendered, "fa")!;
    const b = standaloneSvg(rendered, "fb")!;
    expect(a).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(a).toContain('id="fa-g"');
    expect(a).toContain("url(#fa-g)");
    expect(a).toContain("url(#fa-c)");
    expect(a).toContain('href="#fa-g2"');
    expect(a).not.toMatch(/id="g"/);
    expect(isInertSvg(a)).toBe(true);
    const ids = (svg: string) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set([...ids(a), ...ids(b)]).size).toBe(ids(a).length + ids(b).length);
    expect(new Set(ids(a)).size).toBe(ids(a).length);
  });

  it("returns null for markup that is not an svg", () => {
    expect(standaloneSvg("<div>no</div>", "fa")).toBeNull();
    expect(standaloneSvg("", "fa")).toBeNull();
  });
});

describe("B6c a theme change between starts composes the lockup in the new theme from the same cached faces", () => {
  it("embeds the same two cached faces whether the start is dark or light, in that theme's lockup", () => {
    const picture = validatePicture({ v: 1, tipNext: 2, faceA: MASCOT("idle"), faceB: MASCOT("happy"), tip: { id: "hire", head: "Hire a teammate for any job", line: "l", try: "t" }, at: 1 });
    const decode = (options: { dark: boolean }) => decodeURIComponent(splashPage({ ...options, mode: "tip", picture, language: "en" }).split(",").slice(1).join(","));
    const dark = decode({ dark: true });
    const light = decode({ dark: false });
    const face = (page: string, state: string) => page.includes(Buffer.from(MASCOT(state)).toString("base64"));
    for (const page of [dark, light]) {
      expect(face(page, "idle")).toBe(true);
      expect(face(page, "happy")).toBe(true);
      expect(page).toContain("Hire a teammate for any job");
    }
    expect(dark).not.toBe(light);
  });
});

describe("B8 main rejects payloads over 192 KiB and SVG with script, on* attributes, external href or foreignObject", () => {
  const good = { v: 1, tipNext: 0, faceA: MASCOT("idle"), faceB: MASCOT("happy"), tip: { id: "search", head: "h", line: "l", try: "t" }, at: 1 };
  const write = (picture: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr19b-b8-"));
    try {
      const ok = writeStartupPicture({ userData: dir, picture });
      return { ok, exists: fs.existsSync(path.join(dir, PICTURE_FILE)), mode: ok ? fs.statSync(path.join(dir, PICTURE_FILE)).mode & 0o777 : null, left: fs.readdirSync(dir) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const withFace = (inner: string) => ({ ...good, faceA: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30">${inner}</svg>` });

  it("saves a good picture at mode 0600, and leaves no temp file", () => {
    const saved = write(good);
    expect(saved).toMatchObject({ ok: true, exists: true, mode: 0o600 });
    expect(saved.left).toEqual([PICTURE_FILE]);
  });

  it("refuses every hostile or oversized picture and writes nothing", () => {
    const hostile = [
      withFace("<script>alert(1)</script>"),
      withFace('<circle r="3" onload="x()"/>'),
      withFace('<image href="https://example.com/a.png" width="3" height="3"/>'),
      withFace('<image href="//example.com/a.png" width="3" height="3"/>'),
      withFace("<foreignObject><div/></foreignObject>"),
      withFace('<circle r="3" fill="url(https://example.com/x)"/>'),
      { ...good, faceA: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>` },
      withFace("<s:foreignObject><div/></s:foreignObject>"),
      withFace('<svg:animate attributeName="x"/>'),
      { ...good, faceA: `<svg xmlns="http://www.w3.org/2000/svg">${"x".repeat(PICTURE_MAX_BYTES)}</svg>` },
      { ...good, tip: { ...good.tip, line: "l".repeat(PICTURE_MAX_BYTES) } },
    ];
    for (const picture of hostile) expect(write(picture)).toMatchObject({ ok: false, exists: false });
  });
});
