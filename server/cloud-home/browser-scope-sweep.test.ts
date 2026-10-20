// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cloudRouteDecision } from "../route-policy.ts";

/** Every `/api/...` call the web app makes, with the method written near it (GET when none). Template holes become a placeholder id. */
function webAppCalls(): Map<string, Set<string>> {
  const calls = new Map<string, Set<string>>(), root = fileURLToPath(new URL("../../src/", import.meta.url));
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) { if (name !== "e2e" && name !== "__fixtures__") walk(file); continue; }
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(["'`])(\/api\/[A-Za-z0-9_\-/.${}()?=&:]*?)\1/g)) {
        const path = m[2]!.replace(/\$\{[^}]*\}/g, "x").split("?")[0]!.replace(/\/+$/, "");
        const after = text.slice(m.index!, m.index! + 260), before = text.slice(Math.max(0, m.index! - 80), m.index!);
        const method = /method:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/.exec(after)?.[1] ?? /\.(post|put|patch|delete)\(/i.exec(before)?.[1]?.toUpperCase() ?? "GET";
        if (!calls.has(path)) calls.set(path, new Set()); calls.get(path)!.add(method);
      }
    }
  };
  walk(root);
  return calls;
}

describe("browser scope sweep (data for the scope decision; scope itself is unchanged)", () => {
  it("lists every route the web app calls that the browser scope refuses", () => {
    const refused: string[] = [], allowed: string[] = [];
    for (const [path, methods] of webAppCalls()) for (const method of methods) {
      if (/^\/api\/cloud\/(?:enter|door-state|challenge|refresh)/.test(path)) continue;
      (cloudRouteDecision(method, path, "browser", {}) === "allow" ? allowed : refused).push(`${method} ${path}`);
    }
    refused.sort(); allowed.sort();
    console.log(`BROWSER-SCOPE-REFUSED (${refused.length}) of ${refused.length + allowed.length} web-app calls:\n${refused.join("\n")}`);
    // The owner's passkey browser: the same sweep, split into allowed, allowed after the desktop's step-up, and refused.
    const ownerRefused: string[] = [], ownerStepUp: string[] = [];
    for (const [path, methods] of webAppCalls()) for (const method of methods) {
      if (/^\/api\/cloud\/(?:enter|door-state|challenge|refresh)/.test(path)) continue;
      const decision = cloudRouteDecision(method, path, "owner-browser", {});
      if (decision === "deny") ownerRefused.push(`${method} ${path}`); else if (decision === "step-up required") ownerStepUp.push(`${method} ${path}`);
    }
    console.log(`OWNER-BROWSER-REFUSED (${ownerRefused.length}):\n${ownerRefused.sort().join("\n")}\nOWNER-BROWSER-STEP-UP (${ownerStepUp.length}):\n${ownerStepUp.sort().join("\n")}`);
    expect(ownerRefused.length).toBeLessThan(refused.length / 4);
    expect(allowed.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    // The scope decision is not made here: chat-level routes stay allowed, credential and desktop-only routes stay refused.
    expect(cloudRouteDecision("GET", "/api/health", "browser", {})).toBe("allow");
    expect(cloudRouteDecision("POST", "/api/cloud/devices/x", "browser", {})).not.toBe("allow");
  });
});
