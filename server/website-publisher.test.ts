// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { describe, expect, it } from "vitest";
import { parseBotPackage, packageAgentProfileReviewHash } from "./bot-package.ts";
import { checkLibrarySkill } from "./skills.ts";
import { parseSkillManifest } from "./skill-library.ts";
import { scanSkill } from "./skill-guard/scan.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const skillRoot = join(root, "skills-library/website-publisher");
const templates = join(skillRoot, "assets/templates");
const read = (path: string) => readFileSync(path, "utf8");
const skillText = read(join(skillRoot, "SKILL.md"));
const manifest = parseSkillManifest(JSON.parse(read(join(skillRoot, "manifest.json"))), skillRoot);
const names = ["quiz", "survey", "lead-capture", "landing-page"];
const pages = names.flatMap(name => readdirSync(join(templates, name)).map(file => join(templates, name, file)));
type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
function elements(node: Node): Element[] {
  const children = "childNodes" in node ? node.childNodes.flatMap(elements) : [];
  return "tagName" in node ? [node, ...children] : children;
}
const attr = (node: Element, name: string) => node.attrs.find(item => item.name === name)?.value;
const has = (node: Element, name: string) => attr(node, name) !== undefined;
const documentElements = (path: string) => elements(parse(read(path)));

describe("website publisher catalog contract", () => {
  it("passes the installer's read-only gate and the switch-on scan", () => {
    expect(checkLibrarySkill(manifest.id, join(root, "skills-library"))).not.toHaveProperty("error");
    const scan = scanSkill({ name: manifest.id, description: manifest.description, triggerTerms: manifest.triggerTerms, files: [{ path: "SKILL.md", content: skillText }] });
    expect(scan.findings).toEqual([]);
    expect(scan.verdict).toBe("clean");
    const verdicts = JSON.parse(read(join(root, "skills-library/scan-verdicts.json")));
    expect(verdicts.skills[manifest.id]).toEqual({ verdict: scan.verdict, contentHash: scan.contentHash, rules: [] });
  });

  it("resolves the bot, its skill, assigned playbook and catalog review hash", () => {
    const { package: pkg } = parseBotPackage(JSON.parse(read(join(root, "bot-library/builtins/site-builder.json"))));
    expect(pkg.agents[0].skills).toEqual([manifest.id]);
    expect(pkg.agents[0].playbooks).toEqual([pkg.playbooks![0].key]);
    const catalog = JSON.parse(read(join(root, "library/catalog.json")));
    const entry = catalog.teams.find((item: { slug: string }) => item.slug === pkg.id);
    expect(entry.skills).toEqual([`teams/${pkg.id}/skills/${manifest.id}/SKILL.md`]);
    expect(entry.profileReviewHash).toBe(packageAgentProfileReviewHash(pkg, pkg.agents[0]));
    expect(pkg.playbooks![0].instructions).toContain("website-publisher");
    expect(pkg.playbooks![0].instructions).toContain("publish_site");
  });

  it("ships each referenced template and says the installer copies the assets", () => {
    expect(readdirSync(templates).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(skillText).toContain(`assets/templates/${name}/`);
      expect(existsSync(join(templates, name, "index.html"))).toBe(true);
    }
    expect(skillText).toContain("Murage copies the\n   skill's `assets/` folder");
    expect(skillText).toContain("Connect Netlify");
    expect(skillText).toContain("terms for commercial use");
  });

  it("keeps the new skill, bot and template copy within house rules", () => {
    const texts = [skillText, read(join(skillRoot, "manifest.json")), read(join(root, "bot-library/builtins/site-builder.json")), ...pages.map(read)];
    for (const text of texts) {
      expect(text).not.toMatch(/\u2014|\b(?:safe|safely|safety|unsafe|composio|always-on|self-evolving)\b/i);
      expect(text).not.toMatch(/\b(?:price|pricing|paid|cost|discount)\b|[$€£]\d/i);
    }
  });
});

describe("static website template contracts", () => {
  it.each(pages)("%s has editable copy, semantic structure and local resources", path => {
    const source = read(path);
    const nodes = documentElements(path);
    expect(source.indexOf("CONTENT BLOCK")).toBeLessThan(500);
    expect(source.indexOf("END CONTENT BLOCK")).toBeLessThan(source.indexOf("<style>"));
    expect(attr(nodes.find(node => node.tagName === "html")!, "lang")).toBe("en");
    expect(nodes.filter(node => node.tagName === "h1")).toHaveLength(1);
    expect(nodes.filter(node => node.tagName === "main")).toHaveLength(1);
    expect(nodes.some(node => node.tagName === "meta" && attr(node, "name") === "viewport")).toBe(true);
    const ids = nodes.filter(node => has(node, "id")).map(node => attr(node, "id"));
    expect(new Set(ids).size).toBe(ids.length);
    for (const node of nodes) {
      for (const key of ["src", "href"]) {
        const target = attr(node, key);
        if (!target) continue;
        expect(target).not.toMatch(/^(?:https?:)?\/\//);
        if (target.startsWith("#")) expect(ids).toContain(target.slice(1));
        else if (!target.startsWith("mailto:")) expect(existsSync(join(dirname(path), target))).toBe(true);
      }
      if (node.tagName === "img") expect(has(node, "alt")).toBe(true);
    }
    expect(source).not.toMatch(/@import|fetch\(|XMLHttpRequest|localStorage|sessionStorage/);
    expect(source).toContain(":focus-visible");
    expect(Buffer.byteLength(source)).toBeLessThan(30_000);
  });

  it.each(["quiz", "survey", "lead-capture"])("%s posts detectable forms with a honeypot and a real completion page", name => {
    const directory = join(templates, name);
    const nodes = documentElements(join(directory, "index.html"));
    const forms = nodes.filter(node => node.tagName === "form");
    expect(forms).toHaveLength(1);
    for (const form of forms) {
      expect(attr(form, "data-netlify")).toBe("true");
      expect(attr(form, "method")).toBe("POST");
      expect(attr(form, "netlify-honeypot")).toBe("bot-field");
      expect(existsSync(join(directory, attr(form, "action")!))).toBe(true);
      const fields = elements(form).filter(node => ["input", "select", "textarea"].includes(node.tagName));
      expect(attr(fields.find(node => attr(node, "name") === "form-name")!, "value")).toBe(attr(form, "name"));
      const honeypot = fields.find(node => attr(node, "name") === "bot-field")!;
      expect(honeypot).toBeDefined();
      expect(elements(form).some(node => has(node, "hidden") && elements(node).includes(honeypot))).toBe(true);
      for (const field of fields) {
        expect(attr(field, "name")).toBeTruthy();
        if (attr(field, "type") === "hidden") continue;
        expect(nodes.some(label => label.tagName === "label" && (
          (has(field, "id") && attr(label, "for") === attr(field, "id")) || elements(label).includes(field)
        ))).toBe(true);
      }
    }
  });

  it("covers every quiz score exactly once and keeps contact optional", () => {
    const nodes = documentElements(join(templates, "quiz/index.html"));
    const steps = nodes.filter(node => has(node, "data-step"));
    expect(steps.length).toBeGreaterThan(1);
    let scores = [0];
    for (const step of steps) {
      const values = elements(step).filter(node => attr(node, "type") === "radio").map(node => Number(attr(node, "value")));
      expect(values.length).toBeGreaterThan(1);
      scores = scores.flatMap(score => values.map(value => score + value));
    }
    const ranges = nodes.filter(node => has(node, "data-min"));
    expect(ranges.length).toBeGreaterThan(1);
    for (const score of scores) expect(ranges.filter(node => score >= Number(attr(node, "data-min")) && score <= Number(attr(node, "data-max")))).toHaveLength(1);
    expect(attr(nodes.find(node => node.tagName === "main")!, "data-email-capture")).toBe("false");
    expect(has(nodes.find(node => attr(node, "id") === "email-capture")!, "hidden")).toBe(true);
    expect(nodes.some(node => node.tagName === "noscript")).toBe(true);
    expect(nodes.some(node => attr(node, "id") === "restart")).toBe(true);
  });
});
