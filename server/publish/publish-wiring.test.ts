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

// MAIN 2026-11-17T17:20Z Q3: a publish card gets the same thread waiting flag and notification as image and HighLevel cards.
// 1.0.20 hlstrip: the HighLevel cards are removed with Murage's own HighLevel.
it("image and publish cards both wait through the one service waiting function and its shared flag", () => {
  const index = read("../index.ts");
  for (const [make, service] of [["const imageOperations = new ImageOperations", "image"], ["const publishOperations = new PublishOperations", "publish"]]) {
    const start = index.indexOf(make);
    expect(start, make).toBeGreaterThan(0);
    // The constructor call ends at its closing "});" (a line of its own, or after the last option).
    const block = index.slice(start, start + index.slice(start).search(/\n\}\);|\} \}\);/));
    // design1019-approval-attention: the shared flag is the attention module's generation-owned wait (attentionWait),
    // and every service passes the actor/claim generation it captured, never the thread's current turn.
    expect(block, make).toContain(`serviceCardWaiting(approvalAttention, "${service}", {`);
    // The image close also passes whether the owner answered (an abandoned call never resumes a parked project board).
    expect(block, make).toMatch(service === "image" ? /generation \? \{ generation \} : undefined, answered\)/ : /generation \? \{ generation \} : undefined\)/);
    expect(block, make).not.toMatch(/setWaitingOnHuman|noteHumanWait/);
  }
  const at = index.indexOf("function attentionWait(");
  expect(at).toBeGreaterThan(0);
  const flag = index.slice(at, index.indexOf("\n}", at));
  expect(flag).toMatch(/setWaitingOnHuman\(threadId, waiting, requestId, generation\)/);
  expect(flag).toMatch(/noteHumanWait\(threadId, requestId, waiting, generation\)/);
  expect(index).toContain("wait: attentionWait,");
});
