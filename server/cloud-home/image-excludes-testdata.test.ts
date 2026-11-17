// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Cloud home image unpacks `git archive <revision>` into /opt/murage (deploy/cloud-home/build-image.sh). deploy/cloud-home/testdata is a test
// fixture (the released 1.0.18 murage-control, byte for byte); it must stay out of the image. Fails if the export-ignore rule or the build-time
// guard goes away, and (when the checkout is a git repository) if git itself no longer treats the file as export-ignored.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

it(".gitattributes export-ignores deploy/cloud-home/testdata", () => {
  const lines = readFileSync(resolve(root, ".gitattributes"), "utf8").split("\n").map((l) => l.trim());
  expect(lines).toContain("/deploy/cloud-home/testdata export-ignore");
});

it("build-image.sh stops the build when testdata is in the archived tree", () => {
  const script = readFileSync(resolve(root, "deploy/cloud-home/build-image.sh"), "utf8");
  // MAIN RULING INT-CONFLICT-DEFAULT 6508938c1acb over cca25f07a97:
  // Follow the image's declared links to compare the extracted and guarded trees.
  const extraction = /^git -C "\$source_dir" archive "\$revision" \| tar (?<options>[^\n]*?) -C (?<directory>\/\S+)$/m.exec(script);
  const archive = extraction?.index ?? -1;
  const guard = script.indexOf("[ -e /opt/murage/deploy/cloud-home/testdata ]");
  const install = script.indexOf("pnpm install --frozen-lockfile");
  expect(archive).toBeGreaterThan(-1);
  expect(extraction?.groups?.options.split(/\s+/)).toEqual(expect.arrayContaining(["-x", "--no-same-owner"]));
  const links = new Map([...script.slice(0, archive).matchAll(/^ln -s (\S+) (\/\S+)$/gm)].map((match) => [match[2], match[1]]));
  let imageTree = "/opt/murage";
  for (let i = 0; i < links.size && links.has(imageTree); i++) imageTree = posix.resolve(posix.dirname(imageTree), links.get(imageTree)!);
  expect(imageTree).toBe(extraction?.groups?.directory);
  expect(guard).toBeGreaterThan(archive);
  expect(guard).toBeLessThan(install);
  expect(script.slice(guard, guard + 300)).toContain("exit 1");
});

it("git reports the testdata directory as export-ignored (skipped when this checkout has no usable git)", (ctx) => {
  let out = "";
  try { out = execFileSync("git", ["-C", root, "check-attr", "export-ignore", "--", "deploy/cloud-home/testdata"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { ctx.skip(); }
  expect(out).toContain("export-ignore: set");
});

it("the real `git archive HEAD` output carries no testdata file (skipped when this checkout has no usable git)", (ctx) => {
  let names: string[] = [];
  try {
    const tar = execFileSync("sh", ["-c", `git -C "${root}" -c safe.directory='*' archive HEAD deploy/cloud-home | tar -t`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    names = tar.split("\n").filter(Boolean);
  } catch { ctx.skip(); }
  expect(names).toContain("deploy/cloud-home/murage-control"); // the listing is real, not empty
  expect(names.filter((name) => name.includes("testdata"))).toEqual([]);
});
