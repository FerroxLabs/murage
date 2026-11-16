import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { gitFixture } from "./git-fixture.mjs";

it("creates its own index and object store even when ambient Git metadata is unusable", () => {
  vi.stubEnv("GIT_DIR", "/absent/runner-metadata");
  vi.stubEnv("GIT_INDEX_FILE", "/absent/runner-index");
  const fixture = gitFixture(["scripts/check-repository-custody.mjs"]);
  try {
    expect(fixture.git("rev-parse", "--git-dir").trim()).toBe(".git");
    expect(fixture.git("ls-files")).toContain("scripts/check-repository-custody.mjs");
    writeFileSync(join(fixture.root, "isolated.txt"), "fixture\n");
    fixture.git("add", "isolated.txt");
    expect(fixture.git("show", ":isolated.txt")).toBe("fixture\n");
    expect(readFileSync(join(fixture.root, ".fixture-gitconfig"), "utf8")).toBe("");
  } finally {
    fixture.dispose();
    vi.unstubAllEnvs();
  }
});


it("a complete source fixture never tracks ignored runtime payloads from another test", () => {
  const source = gitFixture(["package.json"]);
  let copied: ReturnType<typeof gitFixture> | undefined;
  try {
    mkdirSync(join(source.root, ".planning", "model"), { recursive: true });
    writeFileSync(join(source.root, ".planning", "model", "runtime.bin"), "untracked runtime bytes");
    writeFileSync(join(source.root, "tracked-proof.txt"), "must remain in the audit");
    source.git("add", "tracked-proof.txt");
    mkdirSync(join(source.root, "server", "testing"), { recursive: true });
    writeFileSync(join(source.root, "server", "testing", ".git-ls-files.fixture"), "package.json\0");
    copied = gitFixture(undefined, { sourceRoot: source.root });
    expect(copied.git("ls-files")).toBe(source.git("ls-files"));
    expect(existsSync(join(copied.root, ".planning", "model", "runtime.bin"))).toBe(false);
    expect(copied.git("rev-parse", "--git-dir").trim()).toBe(".git");
  } finally { copied?.dispose(); source.dispose(); }
});
