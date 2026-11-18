// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { steerBuilt } from "../drivers/engine-input.ts";
import { steerBusyDesk } from "../project-card-executor.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";

it("a refused steer carries the revocation code and never reaches the write", async () => {
  const f = new WritetimeFixture();
  const writes: string[] = [];
  const prompt = buildPrompt(undefined, [promptPart("fixture quote", [{ kind: "line", threadId: "missing", messageId: "unseen" }])]);
  try {
    await expect(steerBuilt({ steer: async (_thread, text, beforeWrite) => {
      beforeWrite?.(); writes.push(text); return true;
    } }, "fixture", prompt, { db: f.db, reader: { audience: null } })).rejects.toMatchObject({ code: "MEMORY_CONTEXT_REVOKED" });
    expect(writes).toEqual([]);
  } finally { f.close(); }
});

it("a quote-only refusal queues without revoking the valid retained context", async () => {
  const f = consumingFixture();
  const writes: string[] = [];
  const prompt = buildPrompt(undefined, [promptPart("fixture quote", [{ kind: "line", threadId: "missing", messageId: "unseen" }])]);
  try {
    await expect(steerBusyDesk({ capabilities: { queueing: true }, steer: async (_thread, text, beforeWrite) => {
      beforeWrite?.(); writes.push(text); return true;
    } }, "T", prompt, true, undefined, undefined, undefined, undefined,
    { db: f.f.db, retained: f.turn, reader: { audience: null } })).resolves.toBe("queue");
    expect(writes).toEqual([]);
    expect(f.refusals).toBe(0);
  } finally { f.close(); }
});

it("a revoked retained context remains terminal instead of queueing the quote", async () => {
  const f = consumingFixture();
  const writes: string[] = [];
  const prompt = buildPrompt(undefined, [promptPart("fixture quote", [{ kind: "line", threadId: "missing", messageId: "unseen" }])]);
  try {
    f.flip();
    await expect(steerBusyDesk({ capabilities: { queueing: true }, steer: async (_thread, text, beforeWrite) => {
      beforeWrite?.(); writes.push(text); return true;
    } }, "T", prompt, true, undefined, undefined, undefined, undefined,
    { db: f.f.db, retained: f.turn, reader: { audience: null } })).rejects.toMatchObject({ code: "MEMORY_CONTEXT_REVOKED" });
    expect(writes).toEqual([]);
    expect(f.refusals).toBe(1);
  } finally { f.close(); }
});
