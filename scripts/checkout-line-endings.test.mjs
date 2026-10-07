// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every text file checks out with LF on every OS. A Windows runner with
// core.autocrlf checked sources out with CRLF, and tests that hash a frozen
// corpus, slice a source on "\n" or embed a shipped file all failed there
// (CI 36317693740, Windows shards 1 and 2).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repository = fileURLToPath(new URL("../", import.meta.url));

function trackedLineEndings() {
  const result = spawnSync("git", ["ls-files", "--eol"], { cwd: repository, encoding: "utf8", maxBuffer: 64 * 1024 ** 2 });
  if (result.status !== 0) return null;
  return result.stdout.split("\n").filter(Boolean).map(line => {
    const [info, path] = line.split("\t");
    const [index, , attributes = ""] = info.trim().split(/\s+(?=w\/|attr\/)/);
    return { path, index, attributes: attributes.replace(/^attr\//, "").trim() };
  });
}

test("every tracked text file is checked out with LF; only files named as bytes are left alone", context => {
  const files = trackedLineEndings();
  if (files === null) return context.skip("not a git checkout");
  assert.ok(files.length > 1000);
  const notLf = files.filter(file => file.index !== "i/-text" && !/\beol=lf\b/.test(file.attributes) && !/(^|\s)-text\b/.test(file.attributes));
  assert.deepEqual(notLf, []);
  // A text file stored with CRLF would be rewritten on checkout; it must be
  // one that is deliberately kept byte for byte.
  const crlf = files.filter(file => file.index === "i/crlf" || file.index === "i/mixed");
  assert.ok(crlf.every(file => /(^|\s)-text\b/.test(file.attributes)), JSON.stringify(crlf));
});
