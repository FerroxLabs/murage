// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Static guard for the daily live-Flux contract check: every Flux URL the code
// uses is in the probed list, and every listed endpoint has a probe.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FLUX_CALLER_FILES, FLUX_ENDPOINTS, FLUX_KNOWN_UNSERVED } from "./flux-contract-endpoints.ts";

const root = join(import.meta.dirname, "..");
const ALLOWED = [
  "/v1/chat/completions", "/v1/messages", "/v1/messages/count_tokens", "/v1/responses", "/v1/models",
  "/v1/audio/speech", "/v1/audio/transcriptions", "/v1/audio/voices", "/v1/voice/lookup",
  "/v1/images/generations", "/v1/images/edits", "/v1/search", "/v1/decide",
  "/anthropic/v1/messages", "/composio/health", "/composio/v1/me",
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}
const NAMES = /FLUX_OPENAI_BASE|FLUX_RESPONSES_BASE|FLUX_ANTHROPIC_BASE|api\.fluxrouter\.ai|MURAGE_FLUX_[A-Z_]*API|MURAGE_FLUX_COMPOSIO_BROKER_URL/;
function walk(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(rel);
    return entry.name.endsWith(".ts") && !/\.test\.|\/testing\//.test(rel) ? [rel] : [];
  });
}
const files = [...walk("server"), ...walk("shared")];

describe("Flux contract: endpoint list", () => {
  it("only allowed paths are listed", () => {
    for (const endpoint of FLUX_ENDPOINTS) expect(ALLOWED, endpoint.id).toContain(endpoint.path);
    for (const path of ALLOWED) expect(FLUX_ENDPOINTS.map((e) => e.path), path).toContain(path);
  });

  it("every file that uses a Flux base or host is listed, and every listed file still does", () => {
    const using = files.filter((f) => NAMES.test(stripComments(readFileSync(join(root, f), "utf8"))));
    const listed = Object.keys(FLUX_CALLER_FILES);
    expect(using.filter((f) => !listed.includes(f)), "new Flux caller: add it to server/flux-contract-endpoints.ts and probe it").toEqual([]);
    expect(listed.filter((f) => !using.includes(f)), "listed file no longer uses Flux: remove it").toEqual([]);
  });

  it("every endpoint a caller uses is a listed endpoint", () => {
    const ids = new Set(FLUX_ENDPOINTS.map((e) => e.id));
    for (const [file, used] of Object.entries(FLUX_CALLER_FILES)) for (const id of used) expect(ids.has(id), `${file}: ${id}`).toBe(true);
  });

  it("every literal api.fluxrouter.ai URL is a probed path or a known-unserved one", () => {
    const paths = new Set(FLUX_ENDPOINTS.map((e) => e.path));
    const found: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(join(root, file), "utf8"));
      for (const match of code.matchAll(/(?:https?|wss):\/\/api\.fluxrouter\.ai(\/[A-Za-z0-9_./-]*)?/g)) {
        const path = (match[1] ?? "").replace(/\/+$/, "");
        if (!path || path === "/v1" || path === "/anthropic" || path === "/composio") continue; // a base: its callers are checked above
        found.push(`${file}: ${path}`);
        const unserved = FLUX_KNOWN_UNSERVED.some((p) => path === p || path.startsWith(`${p}/`));
        expect(paths.has(path) || unserved, `${file} calls ${path}, which the daily contract check does not probe`).toBe(true);
      }
    }
    expect(found.length).toBeGreaterThan(0);
  });

  it("every listed endpoint has a probe in the live check", () => {
    const live = readFileSync(join(import.meta.dirname, "flux-contract.live.test.ts"), "utf8");
    for (const endpoint of FLUX_ENDPOINTS) expect(live, endpoint.id).toContain(`probe("${endpoint.id}"`);
  });

  it("the daily workflow runs the live check with the named secret and never prints it", () => {
    const workflow = readFileSync(join(root, ".github/workflows/flux-contract-daily.yml"), "utf8");
    expect(workflow).toMatch(/schedule:[\s\S]*cron:/);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("secrets.FLUX_CONTRACT_KEY");
    expect(workflow).toContain("server/flux-contract.live.test.ts");
    expect(workflow).not.toMatch(/echo[^\n]*\$\{?FLUX_CONTRACT_KEY/);
    expect(workflow).not.toMatch(/set -x/);
  });
});
