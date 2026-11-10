// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE LOGO AS DATA (C1, C2, C3). One builder feeds the welcome, the splash and the tip header, so these tests pin
// what the builder returns, that its proportions are the brand's, and that the brand files carry no banned words.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BRAND_ORANGE,
  EMBER_DEFAULT_SVG,
  GALAXY_PATHS,
  MARK_BOX,
  MARK_SCALE,
  WORDMARK_PATH,
  emberBox,
  lockupSvg,
} from "./murage-lockup.mjs";

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");

describe("C1 lockupSvg is pure, deterministic and has no text nodes (wordmark outlined)", () => {
  it("gives the same string for the same options, every time", () => {
    const a = lockupSvg({ size: 84, ember: "static" });
    expect(lockupSvg({ size: 84, ember: "static" })).toBe(a);
    expect(lockupSvg()).toBe(lockupSvg({ size: 84, light: false, ember: "none" }));
  });
  it("outlines the wordmark: no text node, no font reference, no title", () => {
    for (const ember of ["none", "static"] as const) {
      for (const light of [false, true]) {
        const svg = lockupSvg({ ember, light });
        expect(svg).not.toMatch(/<text|<tspan|font-family|<title|<script|href="http/i);
        expect(svg).toContain(WORDMARK_PATH);
        for (const d of GALAXY_PATHS) expect(svg).toContain(d);
      }
    }
  });
  it("the plain logo (the first-load picture) has no Ember and no animation", () => {
    const svg = lockupSvg({ ember: "none" });
    expect(svg).not.toMatch(/<animate|<set|@keyframes|animation/i);
    expect(svg).not.toContain("ml-halo");
    expect(svg).not.toContain(EMBER_DEFAULT_SVG.slice(0, 60));
  });
  it("static Ember uses the bundled face by default and a handed-in face when given", () => {
    expect(lockupSvg({ ember: "static" })).toContain("ember-default-0");
    const mine = `<svg viewBox="0 0 10 10" width="30" height="30"><circle id="mine" cx="5" cy="5" r="4"/></svg>`;
    const svg = lockupSvg({ ember: "static", face: mine });
    expect(svg).toContain(`id="mine"`);
    expect(svg).not.toContain("ember-default-0");
    const box = emberBox();
    expect(svg).toContain(`width="${Math.round(box.size * 100) / 100}"`);
    const photo = lockupSvg({ ember: "static", face: "data:image/png;base64,AAAA" });
    expect(photo).toContain(`<image `);
    expect(photo).toContain(`href="data:image/png;base64,AAAA"`);
  });
  it("refuses a face that carries script or reaches outside", () => {
    for (const bad of [
      `<svg><script>alert(1)</script></svg>`,
      `<svg onload="x()"></svg>`,
      `<svg><foreignObject/></svg>`,
      `data:image/svg+xml,<svg>`,
      `<svg><image href="https://example.com/x.png"/></svg>`,
      `<svg><style>*{fill:red}</style></svg>`,
      `<svg><a href="https://example.com"><circle/></a></svg>`,
      `<svg><use href="https://example.com/x.svg#a"/></svg>`,
      `<svg><image href="java&#115;cript:alert(1)"/></svg>`,
      `<svg><circle fill="url(https://example.com/x.svg#a)"/></svg>`,
      `<svg><circle/></svg><svg onclick="x"></svg>`,
      `<svg><circle/></svg><div>trailing</div>`,
      `data:image/svg+xml;base64,AAAA`,
      `<svg><rect/onmouseover="alert(1)" width="100" height="100"/></svg>`,
      `<svg><rect"onclick="x"/></svg>`,
      `<svg style="background-image:u\\72l(https://example.invalid/x)"></svg>`,
      `<svg style="fill:url(https://example.invalid/x)"></svg>`,
      `<svg style=background:red></svg>`,
      `<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>`,
      `<svg><![CDATA[x]]></svg>`,
      `<svg><!-- c --><circle/></svg>`,
      `<svg><title>t</title></svg>`,
      `<svg><circle cursor="url&lpar;https://attacker.example/a.cur&rpar;,auto"/></svg>`,
      `<svg xml:base="https://attacker.example/"><circle/></svg>`,
      `data:image/png;base64,AA"AA`,
      `<div>not an svg</div>`,
      ``,
    ]) {
      expect(() => lockupSvg({ ember: "static", face: bad })).toThrow(TypeError);
    }
    expect(() => lockupSvg({ size: 0 })).toThrow(TypeError);
    expect(() => lockupSvg({ ember: "loop" as never })).toThrow(TypeError);
  });
  it("replaces the face's own size however it is quoted", () => {
    const single = `<svg viewBox='0 0 10 10' width = '30' HEIGHT='30' x="1" y = "2"><circle cx="5" cy="5" r="4"/></svg>`;
    const svg = lockupSvg({ ember: "static", face: single });
    const opening = /<svg viewBox='0 0 10 10' ([^>]*)>/.exec(svg.slice(svg.indexOf("<g filter")))!;
    expect(opening[1].match(/\bwidth=/gi)).toHaveLength(1);
    expect(opening[1].match(/\bheight=/gi)).toHaveLength(1);
    expect(opening[1].match(/\bx=/gi)).toHaveLength(1);
    expect(opening[1]).not.toMatch(/width = |HEIGHT|'30'/);
  });
  it("accepts a fragment reference and an inline raster picture inside the face", () => {
    const ok = `<svg viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><circle fill="url(#g)"/></svg>`;
    expect(() => lockupSvg({ ember: "static", face: ok })).not.toThrow();
  });
  it("the dark ground gets white ink and the light ground gets near-black ink", () => {
    expect(lockupSvg({ light: false })).toContain(`fill="#ffffff"`);
    expect(lockupSvg({ light: true })).toContain(`fill="#111111"`);
    expect(lockupSvg({ light: true })).not.toContain(`fill="#ffffff"`);
  });
  it("scales from the mark height", () => {
    const small = lockupSvg({ size: 30 });
    const big = lockupSvg({ size: 84 });
    const w = (svg: string) => Number(/width="([\d.]+)"/.exec(svg)![1]);
    expect(w(big) / w(small)).toBeCloseTo(84 / 30, 2);
  });
});

describe("C2 lockup proportions: mark 1.43 times cap height, gap 0.35 times cap", () => {
  const brand = read("brand/logo-dark.svg");
  const capHeight = 61.32; // Sora 800 at 84: baseline 96, top of M 34.68
  it("the mark sits where brand/logo-dark.svg puts it", () => {
    expect(brand).toContain(`translate(${MARK_BOX.x.toFixed(2)} ${MARK_BOX.y.toFixed(2)}) scale(${MARK_SCALE.toFixed(5)})`);
    expect(MARK_BOX.size).toBeCloseTo(24 * MARK_SCALE, 1);
  });
  it("mark height is 1.43 times the cap height (stroke included)", () => {
    const withStroke = MARK_BOX.size + 1.9 * MARK_SCALE * 0.34;
    expect(withStroke / capHeight).toBeGreaterThan(1.41);
    expect(withStroke / capHeight).toBeLessThan(1.45);
  });
  it("the outlined M is exactly as tall as the brand's cap height", () => {
    const top = 96 - capHeight;
    expect(WORDMARK_PATH.startsWith("M121.92 96V34.68")).toBe(true);
    expect(top).toBeCloseTo(34.68, 2);
  });
  it("the gap from the mark to the wordmark is 0.35 times the cap height", () => {
    const textX = Number(/<text x="([\d.]+)"/.exec(brand)![1]);
    const gap = (textX - (MARK_BOX.x + MARK_BOX.size)) / capHeight;
    expect(gap).toBeGreaterThan(0.33);
    expect(gap).toBeLessThan(0.37);
    // the first outlined letter starts at (or just after) the brand's text origin
    expect(Number(/^M([\d.]+) /.exec(WORDMARK_PATH)![1])).toBeGreaterThanOrEqual(textX);
  });
  it("Ember stands in the galaxy's lower-left corner at 0.6 of the mark", () => {
    const box = emberBox();
    expect(box.size).toBeCloseTo(MARK_BOX.size * 0.6, 2);
    expect(box.x).toBeLessThan(MARK_BOX.x + MARK_BOX.size * 0.1);
    expect(box.y + box.size).toBeGreaterThan(MARK_BOX.y + MARK_BOX.size);
  });
});

describe("C3 the brand assets contain no comment or text with the banned words", () => {
  const BANNED = /\b(safe|safely|safety|free|forge)\b/i;
  const dir = root("src/assets/brand");
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".svg")) : [];
  it("ships the five brand files", () => {
    expect(files.sort()).toEqual(["ember-default.svg", "murage-logo-dark.svg", "murage-logo-light.svg", "murage-mark.svg", "murage-wordmark.svg"]);
  });
  it("the source mark names the old product colour in a comment; the shipped copy does not", () => {
    expect(read("brand/mark.svg")).toMatch(/Forge/);
    const shipped = read("src/assets/brand/murage-mark.svg");
    expect(shipped).not.toMatch(/<!--/);
    expect(shipped).not.toMatch(/Forge/i);
  });
  it("no shipped brand file has a comment, a text node, an em or en dash, or a banned word", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = read(`src/assets/brand/${name}`);
      expect(text, name).not.toMatch(/<!--/);
      expect(text, name).not.toMatch(/<text|<title|<desc/i);
      expect(text, name).not.toMatch(/[–—]/);
      expect(text, name).not.toMatch(BANNED);
    }
  });
  it("the module itself, with its comments, is clean too", () => {
    const text = read("shared/murage-lockup.mjs");
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\b(safe|free|forge)\b/i);
  });
  it("the galaxy in the shipped mark is byte-identical to the module's and to brand/mark.svg", () => {
    const shipped = read("src/assets/brand/murage-mark.svg");
    const source = read("brand/mark.svg");
    for (const d of GALAXY_PATHS) {
      expect(shipped).toContain(d);
      expect(source).toContain(d);
    }
    expect(shipped).toContain(BRAND_ORANGE);
  });
});
