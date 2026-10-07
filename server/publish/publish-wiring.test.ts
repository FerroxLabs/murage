// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// The publish gate is structural: no permission level is read anywhere on its path.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const SKIPS = /fullAccess|hasFullAccess|hasNoLimits|autoApprov|decideImageApproval|permissionMode|allowKey|taskAllowKey|routineAllowKey|alwaysAllow/i;

it("the publish operations never consult an access level and offer no remembered grant", () => {
  const ops = read("./publish-ops.ts").split("\n").filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");
  expect(ops).not.toMatch(SKIPS);
});

it("the publish routes in the server read no access level either", () => {
  const index = read("../index.ts");
  const start = index.indexOf('if ((path === "/api/internal/publish-site"');
  const end = index.indexOf('if (path === "/api/internal/generate-image"');
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  expect(index.slice(start, end)).not.toMatch(SKIPS);
  const make = index.indexOf("const publishOperations = new PublishOperations");
  expect(index.slice(make, make + 900)).not.toMatch(SKIPS);
});

it("every engine reaches both tools through the agents server, and an answer on a publish card reaches the publish operations", () => {
  const proxy = read("../drivers/agents-proxy.ts");
  expect(proxy).toMatch(/name: "publish_site"/);
  expect(proxy).toMatch(/name: "take_down_site"/);
  const index = read("../index.ts");
  expect(index).toMatch(/publishOperations\.resolve\(threadId, requestId, behavior\)/);
  expect(index).toMatch(/publishOperations\.cancelThread\(threadId\)/);
});
