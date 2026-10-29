// SPDX-License-Identifier: AGPL-3.0-or-later
// Every third-party action a workflow runs is pinned to a full commit sha, never a tag a
// publisher can move. scale-budget.yml writes the build host root key and was the one left on
// tags (upstream 3a5935956's class).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  ...readdirSync(join(root, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(".github/workflows", f)),
  ...readdirSync(join(root, ".github/actions")).map((d) => join(".github/actions", d, "action.yml")),
];

describe("workflow action pins", () => {
  it.each(files)("%s pins every external action to a commit sha", (file) => {
    const unpinned = readFileSync(join(root, file), "utf8").split("\n")
      .map((line) => /^\s*-?\s*uses:\s*["']?([^\s"'#]+)/.exec(line)?.[1])
      .filter((ref) => ref && !ref.startsWith("./") && !ref.startsWith("docker://") && !/@[0-9a-f]{40}$/.test(ref));
    expect(unpinned).toEqual([]);
  });
});
