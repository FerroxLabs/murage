// Every Playwright config — the per-spec ones and the root playwright.config.ts
// — routes its outputDir through evidence.ts, so no human spec can write
// screenshots, traces or reports into the checkout (CLAC2 finding 4, CLAC3
// sweep, FOLLOW4 for the root config). Playwright wipes outputDir before a
// run, so since SAFEWIPE1 the root and any override are also held to the
// safe-wipe admission rules: a scratch-marked or temp path, never a home or
// data dir.
import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    process.env.MURAGE_E2E_DATA_DIR = "/lane/.e2e/CLAC3";
    expect(evidenceDir("claude-accounts")).toBe(join("/lane/.e2e/CLAC3", "claude-accounts-results"));
    expect(evidenceRoot("claude-accounts")).toBe("/lane/.e2e/CLAC3");
  });

  it("honours a spec's own documented override only when it is set", () => {
    process.env.MURAGE_E2E_DATA_DIR = "/lane/.e2e/CLAC3";
    expect(evidenceDir("local-models", "/proof/evidence-local-models")).toBe("/proof/evidence-local-models");
    expect(evidenceDir("local-models", "")).toBe(join("/lane/.e2e/CLAC3", "local-models-results"));
    expect(evidenceDir("local-models", undefined)).toBe(join("/lane/.e2e/CLAC3", "local-models-results"));
    delete process.env.MURAGE_E2E_DATA_DIR;
    expect(evidenceDir("local-models", "/proof/evidence-local-models")).toBe("/proof/evidence-local-models");
  });

  it("refuses a root or override Playwright must never wipe: a home, a data dir, an unmarked path", () => {
    const home = userInfo().homedir;
    process.env.MURAGE_E2E_DATA_DIR = join(home, ".murage");
    expect(() => evidenceDir("startup")).toThrow(/REFUSED[\s\S]*Murage data directory|REFUSED[\s\S]*home directory/);
    process.env.MURAGE_E2E_DATA_DIR = "/lane/.e2e/CLAC3";
    expect(() => evidenceDir("startup", home)).toThrow(/REFUSED[\s\S]*home directory/);
    expect(() => evidenceDir("startup", "/proof/local-models")).toThrow(/REFUSED[\s\S]*not marked scratch/);
    process.env.MURAGE_E2E_DATA_DIR = "/lane/e2e/CLAC3";
    expect(() => evidenceRoot("startup")).toThrow(/REFUSED[\s\S]*not marked scratch/);
  });

  it("is the outputDir of the root playwright.config.ts, with the same refusal", async () => {
    // The root config used to leave outputDir at Playwright's default,
    // test-results/ inside the repository (CLAC3 verifier). It is loaded
    // fresh each time: rig.ts and evidence.ts read the environment at import.
    process.env.MURAGE_E2E_DATA_DIR = "/lane/.e2e/FOLLOW4";
    vi.resetModules();
    const configured = (await import("../../playwright.config")).default;
    expect(configured.outputDir).toBe(join("/lane/.e2e/FOLLOW4", "human-results"));
    expect(configured.testDir).toBe("./src/e2e");
    delete process.env.MURAGE_E2E_DATA_DIR;
    vi.resetModules();
    // rig.ts loads before the config body and refuses first (SAFEWIPE1);
    // evidence.ts refuses the same way for outputDir on its own.
    await expect(import("../../playwright.config")).rejects.toThrow(/MURAGE_E2E_DATA_DIR is required — the shared human rig never uses ~\/\.murage/);
    expect(() => evidenceDir("human")).toThrow("MURAGE_E2E_DATA_DIR is required — human browser evidence is never written inside the repository.");
    // And an unmarked root is refused at import, before Playwright could wipe it.
    process.env.MURAGE_E2E_DATA_DIR = "/lane/e2e/FOLLOW4";
    vi.resetModules();
    await expect(import("../../playwright.config")).rejects.toThrow(/REFUSED[\s\S]*not marked scratch/);
    delete process.env.MURAGE_E2E_DATA_DIR;
    const source = readFileSync(join(here, "..", "..", "playwright.config.ts"), "utf8");
    expect(source).not.toMatch(/outputDir\s*:\s*["']/);
    expect(source).not.toMatch(/outputFile\s*:\s*["']/);
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
