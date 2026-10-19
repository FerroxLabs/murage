import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cloudHealthVersion } from "./health.ts";
afterEach(() => vi.unstubAllEnvs());
it("reports the installed server version and home protocol", () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  expect(cloudHealthVersion()).toEqual({ serverVersion: pkg.version, protocol: 1 });
});
it("reports the home role only when the server is flagged as a home", () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); expect(cloudHealthVersion().role).toBe("home");
  vi.stubEnv("MURAGE_CLOUD_ROLE", ""); expect(cloudHealthVersion()).not.toHaveProperty("role");
});
