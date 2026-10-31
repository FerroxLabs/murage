// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// GROK-STOPPED owner card closers (1.0.10): an owner card closes only on the owner's answer, the owner's Stop, or its engine or Murage
// going away. Stop (closeOpenApprovals) closes every card of the conversation as Not answered. The browser card path is base behaviour
// in 1.0.10 and is redesigned in the 1.0.11 lane BROWSER-CARDS-1011.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const code = (text: string) => text.split("\n").filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
const body = (source: string, header: string) => {
  const start = source.indexOf(header);
  expect(start).toBeGreaterThan(0);
  const next = source.indexOf("\nasync function ", start + header.length);
  const fn = source.indexOf("\nfunction ", start + header.length);
  const end = Math.min(...[next, fn].filter(at => at > 0));
  return code(source.slice(start, end));
};

it("Stop and a dead engine close every peer, consent, image and publish card of the conversation as Not answered", () => {
  const index = read("./index.ts");
  const close = body(index, "function closeOpenApprovals(");
  for (const call of ["cancelPeerApprovalsForThread(threadId)", "cancelHostComputerConsentForThread(threadId)", "imageOperations.cancelThread(threadId)", "publishOperations.cancelThread(threadId)"]) expect(close).toContain(call);
  expect(close).toContain('answered: "unavailable", dismissed: true');
});
