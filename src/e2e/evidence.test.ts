// Every per-spec Playwright config routes its outputDir through evidence.ts,
// so no human spec can write screenshots, traces or reports into the checkout
// (CLAC2 finding 4, CLAC3 sweep).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { evidenceDir, evidenceRoot } from "./evidence";

const here = dirname(fileURLToPath(import.meta.url));
const original = process.env.MURAGE_E2E_DATA_DIR;
afterEach(() => { if (original === undefined) delete process.env.MURAGE_E2E_DATA_DIR; else process.env.MURAGE_E2E_DATA_DIR = original; });

describe("evidenceDir", () => {
  it("refuses without MURAGE_E2E_DATA_DIR, naming the spec", () => {
    delete process.env.MURAGE_E2E_DATA_DIR;
    expect(() => evidenceDir("account-localisation")).toThrow("MURAGE_E2E_DATA_DIR is required — account-localisation browser evidence is never written inside the repository.");
    expect(() => evidenceRoot("memory")).toThrow(/MURAGE_E2E_DATA_DIR is required — memory/);
    process.env.MURAGE_E2E_DATA_DIR = "";
    expect(() => evidenceDir("startup")).toThrow(/MURAGE_E2E_DATA_DIR is required/);
  });

  it("puts each spec's results under the lane's data dir", () => {
    process.env.MURAGE_E2E_DATA_DIR = "/lane/e2e/CLAC3";
    expect(evidenceDir("claude-accounts")).toBe(join("/lane/e2e/CLAC3", "claude-accounts-results"));
    expect(evidenceRoot("claude-accounts")).toBe("/lane/e2e/CLAC3");
  });

  it("honours a spec's own documented override only when it is set", () => {
    process.env.MURAGE_E2E_DATA_DIR = "/lane/e2e/CLAC3";
    expect(evidenceDir("local-models", "/proof/local-models")).toBe("/proof/local-models");
    expect(evidenceDir("local-models", "")).toBe(join("/lane/e2e/CLAC3", "local-models-results"));
    expect(evidenceDir("local-models", undefined)).toBe(join("/lane/e2e/CLAC3", "local-models-results"));
    delete process.env.MURAGE_E2E_DATA_DIR;
    expect(evidenceDir("local-models", "/proof/local-models")).toBe("/proof/local-models");
  });

  it("is the only outputDir every per-spec config uses", () => {
    const configs = readdirSync(here).filter(name => name.endsWith(".config.ts"));
    expect(configs.length).toBeGreaterThan(40);
    for (const name of configs) {
      const source = readFileSync(join(here, name), "utf8");
      expect(source, name).toMatch(/from "\.\/evidence"/);
      expect(source, name).not.toMatch(/\.\.\/\.\.\//);
      expect(source, name).not.toMatch(/outputDir\s*:\s*["']/);
      expect(source, name).not.toMatch(/outputFile\s*:\s*["']/);
    }
  });
});
