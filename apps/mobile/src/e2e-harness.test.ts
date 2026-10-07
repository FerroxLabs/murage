// The E2E host must never touch Sean's Murage: ports 8799 and 8810-8813,
// his data, and the Serve entries on :443 and :8443 (Global Constraints).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HOST = new URL("../e2e/host/", import.meta.url);
const scripts = () => readdirSync(HOST).filter((name) => /\.(sh|cjs)$/.test(name)).map((name) => [name, readFileSync(new URL(name, HOST), "utf8")] as const);

describe("the E2E host", () => {
  it("uses only the 288xx ports", () => {
    for (const [name, text] of scripts()) {
      const ports = [...text.matchAll(/\b(\d{4,5})\b/g)].map((m) => Number(m[1])).filter((n) => n >= 8000 && n < 30000 && n !== 8444);
      expect(ports.filter((port) => port < 28000), name).toEqual([]);
    }
  });

  it("adds and removes only the :8444 Serve entry, and proves the config was restored", () => {
    const serve = readFileSync(new URL("serve.sh", HOST), "utf8");
    expect(serve).toContain("serve --bg --https=8444 http://127.0.0.1:28813");
    expect(serve).toContain("serve --https=8444 off");
    expect(serve).toMatch(/diff "\$HERE\/serve-before\.json" "\$HERE\/serve-after\.json"/);
    expect(serve).not.toMatch(/--https=(443|8443)\b/);
  });

  it("builds the web dist on the build host, never with vite on the Mac", () => {
    const build = readFileSync(new URL("build-web-dist.sh", HOST), "utf8");
    expect(build).toContain("ssh \"$HOST\"");
    expect(build).toContain("murage-ci:node24");
  });

  it("starts the server and the door with a scrubbed environment and HOME in the temp data", () => {
    // HOME decides where both look for their data; env -i keeps Sean's
    // MURAGE_* settings and shell PATH out of the throwaway host.
    for (const name of ["run-host.sh", "door.sh"]) {
      const text = readFileSync(new URL(name, HOST), "utf8");
      expect(text, name).toContain('env -i HOME="$DATA"');
    }
  });

  it("keeps the per-run secrets, logs and Serve snapshots out of Git", () => {
    const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8").split("\n");
    for (const entry of ["e2e/host/host.env", "e2e/host/serve-before.json", "e2e/host/serve-after.json", "e2e/host/serve-restored.json", "e2e/host/serve-candidate.json", "e2e/host/door.pid", "e2e/host/companion-data/", "e2e/host/*.log", "e2e/host/web-dist/"]) {
      expect(ignore, entry).toContain(entry);
    }
  });
});

describe("Capacitor's cookie and HTTP plugins stay off in every config the app is built from", () => {
  // P25-P27 run `pnpm build && pnpm sync` before any native build, which
  // regenerates these two copies; a stale copy with either plugin on would
  // reach the shared cookie jars (see capacitor.config.ts).
  const SYNCED = ["../ios/App/App/capacitor.config.json", "../android/app/src/main/assets/capacitor.config.json"];

  it("in capacitor.config.ts", () => {
    const source = readFileSync(new URL("../capacitor.config.ts", import.meta.url), "utf8");
    expect(source).toMatch(/CapacitorCookies:\s*\{\s*enabled:\s*false\s*\}/);
    expect(source).toMatch(/CapacitorHttp:\s*\{\s*enabled:\s*false\s*\}/);
  });

  it.each(SYNCED)("in the synced %s, when it exists", (path) => {
    const url = new URL(path, import.meta.url);
    if (!existsSync(url)) return;
    const plugins = JSON.parse(readFileSync(url, "utf8")).plugins ?? {};
    expect(plugins.CapacitorCookies?.enabled, path).toBe(false);
    expect(plugins.CapacitorHttp?.enabled, path).toBe(false);
  });
});
