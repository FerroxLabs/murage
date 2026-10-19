// SPDX-License-Identifier: AGPL-3.0-or-later
// The light "Opening your Murage home" screen (server/cloud-home/opening-screen.ts) paints the first frame of a Cloud home
// under the home's own policy, with no script.
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { secureHomeHtml } from "./b1b-policy.ts";
import { OPENING_COPY, OPENING_LIGHT, OPENING_MARKUP, OPENING_STYLE, withCloudOpening } from "./opening-screen.ts";

const repo = (path: string) => new URL(`../../${path}`, import.meta.url);
const indexHtml = readFileSync(repo("index.html"), "utf8");
const page = withCloudOpening(indexHtml);

async function served(html: string): Promise<{ csp: string; body: string }> {
  const server = createServer((_req, res) => { secureHomeHtml(res); res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    return await new Promise((resolve, reject) => get({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/" }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ csp: String(res.headers["content-security-policy"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject));
  } finally { server.closeAllConnections?.(); await new Promise<void>(r => server.close(() => r())); }
}
const directive = (csp: string, name: string) => csp.split(";").map(d => d.trim()).find(d => d.startsWith(`${name} `)) ?? "";

describe("the opening screen markup", () => {
  it("is the first thing in <head> and <body>, before any stylesheet or script", () => {
    expect(page.indexOf(OPENING_STYLE)).toBe(page.indexOf("<head>") + "<head>".length);
    expect(page.indexOf(OPENING_MARKUP)).toBe(page.indexOf("<body>") + "<body>".length);
    expect(page.indexOf(OPENING_STYLE)).toBeLessThan(page.indexOf("<script"));
    expect(page.indexOf(OPENING_MARKUP)).toBeLessThan(page.indexOf('<div id="root">'));
  });
  it("adds no script, no event handler and no inline URL of its own", () => {
    for (const part of [OPENING_STYLE, OPENING_MARKUP]) {
      expect(part).not.toMatch(/<script|\son[a-z]+\s*=|javascript:|url\(|@import|expression\(/i);
    }
    expect(page.match(/<script/g)?.length).toBe(indexHtml.match(/<script/g)?.length);
  });
  it("says the door's own words, plainly", () => {
    const door = readFileSync(repo("src/lib/cloud-door.ts"), "utf8");
    expect(door).toContain(`opening: "${OPENING_COPY}",`);
    expect(OPENING_MARKUP).toContain(`<p>${OPENING_COPY}</p>`);
    expect(OPENING_MARKUP + OPENING_STYLE).not.toMatch(/[–—]/);
    expect(OPENING_MARKUP).toContain('role="status"');
    expect(OPENING_MARKUP).toMatch(/<img src="\/murage-logo-dark\.png" alt="Murage"/);
    expect(existsSync(repo("public/murage-logo-dark.png"))).toBe(true);
  });
  it("uses the app's light theme tokens", () => {
    const styles = readFileSync(repo("src/styles.css"), "utf8");
    const light = styles.slice(styles.indexOf('[data-skin="light"] {'));
    const token = (name: string) => new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i").exec(light)?.[1]?.toLowerCase();
    expect(OPENING_LIGHT).toEqual({ app: token("app"), ink: token("ink"), inset: token("inset"), accent: token("accent") });
    expect(OPENING_STYLE).toContain(`html:not([data-murage-mounted]){background:${OPENING_LIGHT.app};color-scheme:light}`);
    expect(OPENING_STYLE).toContain(`background:${OPENING_LIGHT.app};color:${OPENING_LIGHT.ink}`);
    expect(OPENING_STYLE).toContain("@media (prefers-reduced-motion:reduce)");
  });
  it("covers the whole viewport until the app marks itself mounted", () => {
    expect(OPENING_STYLE).toMatch(/#murage-opening\{position:fixed;inset:0;z-index:2147483647;/);
    expect(OPENING_STYLE).toContain("html[data-murage-mounted] #murage-opening{display:none}");
    expect(readFileSync(repo("src/components/cloud/Door.tsx"), "utf8")).toContain('document.documentElement.dataset.murageMounted = "1"');
  });
  it("is added only where the home id is (withCloudHomeId), and leaves other documents alone", () => {
    const index = readFileSync(repo("server/index.ts"), "utf8");
    const fn = index.slice(index.indexOf("function withCloudHomeId("), index.indexOf("const MIME:"));
    expect(fn).toMatch(/if \(!id \|\| [^\n]+\) return html;/);
    expect(fn).toContain("withCloudOpening(html.toString(\"utf8\"))");
    expect(withCloudOpening("<p>no document</p>")).toBe("<p>no document</p>");
  });
});

describe("the opening screen under the home's policy", () => {
  it("is served with script-src 'self' only, and the policy lets its style block and same-origin logo apply", async () => {
    const { csp, body } = await served(page);
    expect(body).toBe(page);
    expect(directive(csp, "script-src")).toBe("script-src 'self'");
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "style-src").split(/\s+/)).toContain("'unsafe-inline'");
    expect(directive(csp, "img-src").split(/\s+/)).toContain("'self'");
    expect(csp).toContain("require-trusted-types-for 'script'");
  });
});
