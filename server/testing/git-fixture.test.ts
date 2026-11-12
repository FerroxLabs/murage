import { readFileSync, writeFileSync } from "node:fs";
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
