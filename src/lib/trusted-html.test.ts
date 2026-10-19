// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

/** A stand-in for window.trustedTypes that records the policies made and wraps what they return. */
function fakeTrustedTypes() {
  const made: { name: string; rules: { createHTML(input: string, kind?: string): string; createScriptURL(input: string): string } }[] = [];
  vi.stubGlobal("trustedTypes", {
    createPolicy(name: string, rules: (typeof made)[number]["rules"]) {
      if (made.some(policy => policy.name === name)) throw new TypeError(`duplicate policy ${name}`);
      made.push({ name, rules });
      return { createHTML: (input: string, kind?: string) => ({ trusted: rules.createHTML(input, kind) }), createScriptURL: (input: string) => ({ trustedUrl: rules.createScriptURL(input) }) };
    },
  });
  return made;
}

describe("the murage Trusted Types policy", () => {
  it("is created once, named murage, and every helper returns what it makes", async () => {
    const made = fakeTrustedTypes();
    const html = await import("./trusted-html");
    expect(html.installTrustedTypes()).not.toBeNull();
    html.installTrustedTypes();
    expect(made.filter(policy => policy.name === "murage")).toHaveLength(1);
    expect(made.map(policy => policy.name)).not.toContain("default");
    expect(html.trustedHtml("<b>x</b>")).toEqual({ trusted: "<b>x</b>" });
    expect(html.trustedScriptUrl("/sw.js")).toEqual({ trustedUrl: "/sw.js" });
  });
  it("creates script URLs only for the service worker", async () => {
    fakeTrustedTypes();
    const html = await import("./trusted-html");
    for (const url of ["/assets/x.js", "https://evil.example/sw.js", "/sw.js?x=1", "javascript:alert(1)"]) expect(() => html.trustedScriptUrl(url), url).toThrow(TypeError);
  });
  it("falls back to the sanitized plain string where the browser has no Trusted Types", async () => {
    const html = await import("./trusted-html");
    expect(html.installTrustedTypes()).toBeNull();
    expect(html.trustedScriptUrl("/sw.js")).toBe("/sw.js");
    expect(() => html.trustedScriptUrl("/other.js")).toThrow(TypeError);
    // No DOM in this realm (node): nothing parses the markup, and a preview frame gets nothing rather than unsanitized content.
    expect(html.trustedPreviewDocument("<script>x</script>")).toBe("");
    // the sanitizer loads once and never rejects, even where it cannot run
    await expect(html.sanitizerReady()).resolves.toBeUndefined();
    expect(html.sanitizerReady()).toBe(html.sanitizerReady());
  });
});

describe("every markup sink in the app", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "e2e" || name === "mermaid-frame" ? [] : files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
  const sources = files(root).map(path => ({ path, text: readFileSync(path, "utf8") }));
  it("takes its markup from the trusted helpers", () => {
    const loose: string[] = [];
    for (const { path, text } of sources) {
      for (const match of text.matchAll(/__html:\s*([^}]+)\}/g)) if (!/^trusted(?:Html|Svg)\(/.test(match[1]!.trim())) loose.push(`${path}: __html: ${match[1]}`);
      for (const match of text.matchAll(/\.(innerHTML|outerHTML)\s*=(?!=)\s*([^;\n]+)/g)) if (!/^trusted(?:Html|Svg)\(/.test(match[2]!.trim())) loose.push(`${path}: ${match[1]} = ${match[2]}`);
      for (const match of text.matchAll(/insertAdjacentHTML|createContextualFragment|document\.write\(|parseFromString\(/g)) loose.push(`${path}: ${match[0]}`);
      for (const match of text.matchAll(/serviceWorker\.register\(\s*([^,)]+)/g)) if (!/^trustedScriptUrl\(/.test(match[1]!.trim())) loose.push(`${path}: register(${match[1]})`);
    }
    expect(loose).toEqual([]);
  });
  it("shows every untrusted page in a SandboxedFrame with a sanitized preview document, never a srcDoc prop", () => {
    const loose: string[] = [];
    for (const { path, text } of sources) {
      if (/\bsrcDoc=/.test(text)) loose.push(`${path}: srcDoc prop`);
      for (const match of text.matchAll(/<SandboxedFrame\b[^>]*?\bhtml=\{([^}]+)\}/g)) {
        const value = match[1]!.trim();
        const memo = /^[a-z]\w*$/i.test(value) && new RegExp(`const ${value} = useMemo\\(\\s*\\(\\) => (?:artifactPreviewHtml|trustedPreviewDocument)\\(`).test(text);
        if (!memo && !/^(?:artifactPreviewHtml|trustedPreviewDocument|renderHtml)\(/.test(value)) loose.push(`${path}: html={${value}}`);
      }
    }
    expect(loose).toEqual([]);
    const frame = readFileSync(join(root, "components/SandboxedFrame.tsx"), "utf8");
    expect(frame).toContain('sandbox="" />');
  });
});
