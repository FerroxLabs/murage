// NO USAGE TRACKING (Sean, standing ruling 11-14): Murage sends no usage
// analytics or telemetry. 1.0.20 still carried the upstream fork's PostHog
// client and a "Usage analytics" switch shown ON. These witnesses keep it out:
// nothing in the app can reach an analytics host on start, on a turn or on a
// settings change, Settings has no such card, the dependency is gone, no
// content-security policy names an analytics host, and an upgraded install
// loses what the old client stored (and nothing else).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = join(__dirname, "..", "..");
const ANALYTICS = /posthog|i\.posthog\.com|murage-analytics|VITE_POSTHOG/i;
// A catalog row that lets an owner connect THEIR OWN PostHog account as a tool
// is not Murage telemetry; it names the product, it never sends to it.
// The upgrade clean-up names the old keys only to delete them; the last
// witness pins that it has no network API at all.
const NOT_TELEMETRY = new Set(["server/app-catalog.ts", "src/lib/legacy-analytics-cleanup.ts"]);

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "e2e" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) productionFiles(path, out);
    else if (/\.(tsx?|mjs|cjs|js|html)$/.test(name) && !/\.(test|spec|node-test)\.|\.fixture\./.test(name)) out.push(path);
  }
  return out;
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("no usage analytics in Murage (1.0.20 re-cut)", () => {
  it("no app code can reach an analytics host: start, turn and settings paths included", () => {
    const hits = ["src", "server", "electron"]
      .flatMap((dir) => productionFiles(join(ROOT, dir)))
      .map((path) => relative(ROOT, path).split("\\").join("/"))
      .filter((rel) => !NOT_TELEMETRY.has(rel) && ANALYTICS.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(hits).toEqual([]);
    const cleanup = readFileSync(join(ROOT, "src/lib/legacy-analytics-cleanup.ts"), "utf8");
    expect(cleanup).not.toMatch(/fetch|XMLHttpRequest|sendBeacon|WebSocket|import\(|from "/);
  });

  it("no analytics dependency is installed", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    expect(Object.keys(deps).filter((name) => /posthog|analytics|telemetry/i.test(name))).toEqual([]);
    const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
    expect(lock).not.toMatch(/posthog/i);
  });

  it("no content-security policy or allowlist names an analytics host", () => {
    const policies = ["src", "electron", "server"]
      .flatMap((dir) => productionFiles(join(ROOT, dir)))
      .concat([join(ROOT, "index.html")].filter((path) => { try { return statSync(path).isFile(); } catch { return false; } }))
      .flatMap((path) => [...readFileSync(path, "utf8").matchAll(/(?:connect|default|script)-src[^"';`]*/g)].map((m) => m[0]));
    expect(policies.length).toBeGreaterThan(0);
    expect(policies.filter((policy) => /posthog|analytics|telemetry|segment|mixpanel|amplitude|sentry/i.test(policy))).toEqual([]);
  });

  it("Settings has no usage analytics card on any surface", () => {
    const sources = [
      "src/components/settings/rows/GeneralRows.tsx",
      "src/components/settings/pages/GeneralPage.tsx",
      "src/components/SettingsSearchResults.tsx",
      "src/lib/settings-card-registry.ts",
      "src/lib/settings-controls.appcards.json",
    ].map((rel) => readFileSync(join(ROOT, rel), "utf8")).join("\n");
    expect(sources).not.toMatch(/usage analytics|analytics-heading|general\.analytics|AnalyticsRow/i);
  });

  it("a configured analytics key still sends nothing when the app starts", async () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "fixture-public-project");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://analytics.fixture.invalid");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => { urls.push(String(url)); return new Response("{}"); }));
    vi.stubGlobal("navigator", { userAgent: "Electron fixture", sendBeacon: (url: string) => { urls.push(url); return true; } });
    const local = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => void local.set(key, value),
      removeItem: (key: string) => void local.delete(key), key: (i: number) => [...local.keys()][i] ?? null, get length() { return local.size; },
    });
    const { startupPrivacy } = await import("./legacy-analytics-cleanup");
    startupPrivacy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls).toEqual([]);
    expect([...local.keys()].filter((key) => /posthog|^ph_|analytics|murage-installed/i.test(key))).toEqual([]);
  });

  it("upgrade deletes what the old analytics client stored, and nothing else", async () => {
    const { purgeLegacyAnalytics } = await import("./legacy-analytics-cleanup");
    const store = new Map<string, string>([
      ["murage-analytics-opt-out", "0"],
      ["murage-analytics-active-day", "2026-11-18"],
      ["murage-installed", "2026-09-02T00:00:00.000Z"],
      ["ph_fixture-public-project_posthog", "{\"distinct_id\":\"fixture-anon\"}"],
      ["__ph_opt_in_out_fixture-public-project", "1"],
      ["ph_fixture-public-project_primary_window_exists", "true"],
      ["murage-email-gate", "skipped"],
      ["murage-theme", "dark"],
      ["phone-layout", "compact"],
    ]);
    const storage = {
      get length() { return store.size; },
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (key: string) => void store.delete(key),
    };
    expect(purgeLegacyAnalytics(storage)).toBe(6);
    expect([...store.keys()].sort()).toEqual(["murage-email-gate", "murage-theme", "phone-layout"]);
    expect(purgeLegacyAnalytics(storage)).toBe(0);
  });
});
