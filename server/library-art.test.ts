// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EMBER_COLOR_HEX } from "../shared/ember-colors.ts";
import { MASCOT_BODY_IDS } from "../shared/mascot-bodies.ts";
import { libraryArtUrl } from "../src/lib/library-art.ts";
import { staticContentType } from "../companion/src/browser.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const csv = readFileSync(join(root, "server/testing/fixtures/library-art-assignments.csv"), "utf8").trim().split("\n");
const header = csv[0].split(",");
const rows = csv.slice(1).map((line) => {
  const cells = line.split(",");
  return Object.fromEntries(header.map((name, index) => [name, cells[index]])) as Record<string, string>;
});

function templatePath(id: string): string {
  const candidates = [join(root, "bot-library/builtins", `${id}.json`), join(root, "library/packages", `${id}.json`)];
  const found = candidates.find((file) => existsSync(file));
  if (!found) throw new Error(`no shipped template for ${id}`);
  return found;
}

describe("template appearance matches the art assignments", () => {
  it("covers every local template", () => {
    expect(rows.length).toBeGreaterThan(500);
    expect(new Set(rows.map((row) => row.template_id)).size).toBe(255);
  });

  it("uses only real colours and bodies", () => {
    for (const row of rows) {
      expect(Object.keys(EMBER_COLOR_HEX), `${row.template_id}/${row.member} colour`).toContain(row.color);
      expect(MASCOT_BODY_IDS as readonly string[], `${row.template_id}/${row.member} body`).toContain(row.mascotBody);
    }
  });

  it("sets mascotBody and colour on every agent, one to one with the CSV", () => {
    const byTemplate = new Map<string, typeof rows>();
    for (const row of rows) byTemplate.set(row.template_id, [...(byTemplate.get(row.template_id) ?? []), row]);
    for (const [id, members] of byTemplate) {
      const agents = JSON.parse(readFileSync(templatePath(id), "utf8")).package.agents as Array<{ key: string; appearance?: { color?: string; mascotBody?: string } }>;
      expect(agents.map((agent) => agent.key).sort(), id).toEqual(members.map((row) => row.member).sort());
      for (const agent of agents) {
        const row = members.find((candidate) => candidate.member === agent.key)!;
        expect(agent.appearance?.color, `${id}/${agent.key} colour`).toBe(row.color);
        expect(agent.appearance?.mascotBody, `${id}/${agent.key} body`).toBe(row.mascotBody);
      }
    }
  });
});

describe("remote-only assistants match their art", () => {
  const remoteLines = readFileSync(join(root, "server/testing/fixtures/library-art-remote-assignments.csv"), "utf8").trim().split("\n");
  const remoteHeader = remoteLines[0].split(",");
  const remoteRows = remoteLines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(remoteHeader.map((name, index) => [name, cells[index]])) as Record<string, string>;
  });

  it("lists all 28 assistants in library/assistants", () => {
    const files = readdirSync(join(root, "library/assistants")).filter((file) => file.endsWith(".json") && !file.startsWith(".")).map((file) => file.replace(/\.json$/, ""));
    expect(remoteRows.map((row) => row.template_id).sort()).toEqual(files.sort());
    expect(remoteRows).toHaveLength(28);
  });

  it("sets mascotBody and colour one to one with the CSV", () => {
    for (const row of remoteRows) {
      expect(Object.keys(EMBER_COLOR_HEX), `${row.template_id} colour`).toContain(row.color);
      expect(MASCOT_BODY_IDS as readonly string[], `${row.template_id} body`).toContain(row.mascotBody);
      const agents = JSON.parse(readFileSync(join(root, "library/assistants", `${row.template_id}.json`), "utf8")).package.agents as Array<{ key: string; appearance?: { color?: string; mascotBody?: string } }>;
      expect(agents.map((agent) => agent.key), row.template_id).toEqual([row.member]);
      expect(agents[0].appearance?.color, `${row.template_id} colour`).toBe(row.color);
      expect(agents[0].appearance?.mascotBody, `${row.template_id} body`).toBe(row.mascotBody);
    }
  });
});

describe("shipped library art", () => {
  const catalog = (JSON.parse(readFileSync(join(root, "library/catalog.json"), "utf8")).teams as Array<{ slug: string }>).map((team) => team.slug);
  const dir = join(root, "public/library-art");

  it("has a card and a detail image for every catalog entry, and nothing else", () => {
    const expected = catalog.flatMap((slug) => [`${slug}-256.webp`, `${slug}-512.webp`]).sort();
    expect(readdirSync(dir).sort()).toEqual(expected);
  });

  it("stays small", () => {
    const total = readdirSync(dir).reduce((sum, file) => sum + statSync(join(dir, file)).size, 0);
    expect(total).toBeLessThan(8 * 1024 * 1024);
  });

  it("builds a URL only for a slug that names a file", () => {
    expect(libraryArtUrl("cold-outbound", 256)).toBe("/library-art/cold-outbound-256.webp");
    expect(libraryArtUrl("cold-outbound", 512)).toBe("/library-art/cold-outbound-512.webp");
    expect(libraryArtUrl("../etc/passwd", 256)).toBeNull();
    expect(libraryArtUrl("", 256)).toBeNull();
    expect(libraryArtUrl("Upper", 256)).toBeNull();
  });

  it("is served by the phone door as WebP", () => {
    expect(staticContentType("/library-art/advisor-256.webp")).toBe("image/webp");
    expect(staticContentType("/library-art/../x-256.webp")).toBeNull();
    expect(staticContentType("/library-art/advisor-300.webp")).toBeNull();
  });
});
